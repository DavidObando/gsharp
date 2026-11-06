// <copyright file="IlVerifyFilterInFinallyRule.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Tests

import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Text.RegularExpressions

/// Recognizes one known `dotnet-ilverify` 10.0.8 false positive (#4489,
/// upstream https://github.com/dotnet/runtime/issues/134711): a
/// `StackUnderflow` reported at the first instruction of an exception
/// FILTER block whose start lies physically inside a `finally` or
/// `fault` handler.
///
/// Root cause: ILVerify's `StartImportingBasicBlock` checks a block's
/// `HandlerIndex` before its `FilterIndex`, so a filter start that
/// sits inside a finally/fault handler inherits that handler's empty entry
/// stack instead of the exception object the CLR pushes. (Inside a catch
/// handler it inherits the catch's exception type, which happens to verify.)
/// Roslyn's IL for the same C# fails identically, and the code runs correctly.
///
/// The rule is deliberately narrow. It never ignores `StackUnderflow` as a
/// category: the reported method must resolve in the assembly's metadata, the
/// reported method identity (type, name, parameter count) must be unique in
/// the assembly, the reported offset must equal one of its filter regions'
/// `FilterOffset`, the instruction there must pop exactly one value, and
/// the innermost handler region enclosing that offset must be `Finally`
/// or `Fault`. Anything else, including a line this class cannot parse or
/// resolve, stays an error.
///
/// Shared (linked source) between the Compiler.Tests `IlVerifier` and the
/// cs2gs self-migration `IlVerifyRunner`.
internal class IlVerifyFilterInFinallyRule {
    private let candidates List[CandidateMethod]

    private init(candidates List[CandidateMethod]) {
        this.candidates = candidates
    }

    /// Returns whether [`errorLine`](paramref) is an ilverify
    /// `StackUnderflow` line for a method and offset recorded by
    /// (cref:Load).
    /// @param errorCode The parsed error code, when the caller has it; a
    /// non-`StackUnderflow` code never matches.
    /// @param errorLine The trimmed ilverify error line.
    /// @returns `true` when the line is the #4489 false positive.
    func Matches(errorCode string?, errorLine string?) bool {
        if this
            .candidates
            .Count == 0 ||
            (errorCode != nil && !string.Equals(errorCode, StackUnderflowCode, StringComparison.Ordinal)) ||
            !TryParse(errorLine, out var typePart, out var methodPart, out var parameterCount, out var offset) {
            return false
        }
        for candidate in this.candidates {
            if candidate.ParameterCount == parameterCount && candidate.FilterOffsets.Contains(offset) &&
                NameMatches(typePart, candidate.TypeName) &&
                NameMatches(methodPart, candidate.MethodName) {
                return true
            }
        }
        return false
    }

    /// One exception region of a method body (test-constructible).
    internal class Region {
        /// Initializes a new instance of the (cref:Region) class.
        /// @param kind The region kind.
        /// @param tryOffset The protected block's start.
        /// @param tryLength The protected block's length.
        /// @param handlerOffset The handler block's start.
        /// @param handlerLength The handler block's length.
        /// @param filterOffset The filter block's start, or -1.
        init(
            kind ExceptionRegionKind,
            tryOffset int32,
            tryLength int32,
            handlerOffset int32,
            handlerLength int32,
            filterOffset int32
        ) {
            this.Kind = kind
            this.TryOffset = tryOffset
            this.TryLength = tryLength
            this.HandlerOffset = handlerOffset
            this.HandlerLength = handlerLength
            this.FilterOffset = filterOffset
        }

        /// Gets the region kind.
        prop Kind ExceptionRegionKind {
            get;
        }

        /// Gets the protected block's start.
        prop TryOffset int32 {
            get;
        }

        /// Gets the protected block's length.
        prop TryLength int32 {
            get;
        }

        /// Gets the handler block's start.
        prop HandlerOffset int32 {
            get;
        }

        /// Gets the handler block's length.
        prop HandlerLength int32 {
            get;
        }

        /// Gets the filter block's start, or -1 for non-filter regions.
        prop FilterOffset int32 {
            get;
        }
    }

    private class CandidateMethod {
        init(typeName string, methodName string, parameterCount int32, filterOffsets List[int32]) {
            this.TypeName = typeName
            this.MethodName = methodName
            this.ParameterCount = parameterCount
            this.FilterOffsets = filterOffsets
        }

        prop TypeName string {
            get;
        }

        prop MethodName string {
            get;
        }

        prop ParameterCount int32 {
            get;
        }

        prop FilterOffsets List[int32] {
            get;
        }
    }

    shared {
        private const StackUnderflowCode string = "StackUnderflow"

        private let OpCodesByValue Dictionary[int16, OpCode] = typeof(OpCodes)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where((field FieldInfo) -> field.FieldType == typeof(OpCode))
            .Select((field FieldInfo) -> OpCode(field.GetValue(nil)!!))
            .ToDictionary((opcode OpCode) -> opcode.Value)

        // [IL]: Error [StackUnderflow]: [<asm> : <Type>::<Method>(<sig>)][offset 0x000001C6] Stack underflow.
        // The location is lazy so `]` inside array signatures does not end it early.
        private let ErrorLine Regex = Regex(
            "^\\[IL\\]:\\s*Error\\s*\\[(?<code>\\w+)\\]:\\s*\\[(?<location>.*?)\\]\\s*\\[offset 0x(?<offset>[0-9A-Fa-f]+)\\]",
            RegexOptions.CultureInvariant
        )

        /// Reads [`assemblyPath`](paramref)'s method bodies and records every
        /// filter start that the ILVerify bug misreports. Returns a rule that
        /// matches nothing when the file is missing or is not a readable
        /// ECMA-335 image (fail-safe: the errors then stay errors).
        /// @param assemblyPath The verified assembly.
        /// @returns The rule for that assembly.
        func Load(assemblyPath string?) IlVerifyFilterInFinallyRule {
            let found = List[CandidateMethod]()
            if string.IsNullOrEmpty(assemblyPath) || !File.Exists(assemblyPath) {
                return IlVerifyFilterInFinallyRule(found)
            }
            try {
                {
                    using let stream = File.OpenRead(assemblyPath!!)
                    {
                        using let pe = PEReader(stream)
                        if !pe.HasMetadata {
                            return IlVerifyFilterInFinallyRule(found)
                        }
                        let reader = pe.GetMetadataReader()
                        // An ilverify line names a method only by type, name and
                        // parameter list, so same-arity overloads are indistinguishable.
                        // Fail closed: a method whose identity is shared by another
                        // MethodDef in the assembly never becomes a candidate.
                        let identityCounts = Dictionary[string, int32](StringComparer.Ordinal)
                        for handle in reader.MethodDefinitions {
                            let key = IdentityKey(reader, reader.GetMethodDefinition(handle))
                            identityCounts.TryGetValue(key, out var count)
                            identityCounts[key] = count + 1
                        }
                        for handle in reader.MethodDefinitions {
                            let method = reader.GetMethodDefinition(handle)
                            if method.RelativeVirtualAddress == 0 || identityCounts[IdentityKey(reader, method)] != 1 {
                                continue
                            }
                            let body = pe.GetMethodBody(method.RelativeVirtualAddress)
                            let regions = List[Region]()
                            for region in body.ExceptionRegions {
                                regions.Add(
                                    Region(
                                        region.Kind,
                                        region.TryOffset,
                                        region.TryLength,
                                        region.HandlerOffset,
                                        region.HandlerLength,
                                        if region.Kind == ExceptionRegionKind.Filter {
                                            region.FilterOffset
                                        } else {
                                            -1
                                        }
                                    )
                                )
                            }
                            let il = body.GetILBytes() ?? Array.Empty[uint8]()
                            let offsets = List[int32]()
                            for region in regions {
                                if region.Kind == ExceptionRegionKind.Filter &&
                                    IsFilterStartInsideFinallyOrFault(regions, region.FilterOffset) &&
                                    PopsExactlyOne(il, region.FilterOffset) &&
                                    CanPatchAndVerifyFilterRegion(
                                    reader,
                                    il,
                                    region.FilterOffset,
                                    region.HandlerOffset,
                                    body.MaxStack
                                ) {
                                    offsets.Add(region.FilterOffset)
                                }
                            }
                            if offsets.Count == 0 {
                                continue
                            }
                            found.Add(
                                CandidateMethod(
                                    GetTypeName(reader, method.GetDeclaringType()),
                                    reader.GetString(method.Name),
                                    GetParameterCount(reader, method),
                                    offsets
                                )
                            )
                        }
                    }
                }
            } catch (BadImageFormatException) {
                found.Clear()
            }
            return IlVerifyFilterInFinallyRule(found)
        }

        /// Issue #5115: writes a shadow copy of [`assemblyPath`](paramref) to
        /// [`shadowPath`](paramref) where each candidate filter-in-finally start
        /// instruction (`isinst`/`castclass` or `pop`) is replaced in-place with
        /// an instruction sequence of the same byte length (`ldnull; nop; nop; nop; nop`
        /// or `nop`) that seeds ILVerify's empty filter-entry stack without shifting
        /// any IL offset or EH clause. Running `ilverify` on the shadow assembly
        /// verifies the remainder of the filter and the rest of the method that
        /// ILVerify otherwise aborts before visiting.
        /// @param assemblyPath The original assembly path.
        /// @param shadowPath The destination path for the patched assembly.
        /// @returns `true` when at least one candidate filter start was patched cleanly.
        internal func TryWritePatchedAssembly(assemblyPath string, shadowPath string) bool {
            if string.IsNullOrEmpty(assemblyPath) || !File.Exists(assemblyPath) {
                return false
            }
            try {
                let bytes = File.ReadAllBytes(assemblyPath)
                if !TryPatchAssemblyBytes(bytes, out var patched) {
                    return false
                }
                let dir = Path.GetDirectoryName(shadowPath)
                if !string.IsNullOrEmpty(dir) {
                    Directory.CreateDirectory(dir)
                }
                File.WriteAllBytes(shadowPath, patched)
                return true
            } catch (BadImageFormatException) {
                return false
            } catch (IOException) {
                return false
            } catch (UnauthorizedAccessException) {
                return false
            }
        }

        internal func TryPatchAssemblyBytes(bytes[]uint8, out patched[]uint8) bool {
            patched = cast[[]uint8](bytes.Clone())
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            if !pe.HasMetadata {
                return false
            }
            let reader = pe.GetMetadataReader()
            let identityCounts = Dictionary[string, int32](StringComparer.Ordinal)
            for handle in reader.MethodDefinitions {
                let key = IdentityKey(reader, reader.GetMethodDefinition(handle))
                identityCounts.TryGetValue(key, out var count)
                identityCounts[key] = count + 1
            }
            var patchedAny = false
            for handle in reader.MethodDefinitions {
                let method = reader.GetMethodDefinition(handle)
                if method.RelativeVirtualAddress == 0 || identityCounts[IdentityKey(reader, method)] != 1 {
                    continue
                }
                let body = pe.GetMethodBody(method.RelativeVirtualAddress)
                let regions = List[Region]()
                for region in body.ExceptionRegions {
                    regions.Add(
                        Region(
                            region.Kind,
                            region.TryOffset,
                            region.TryLength,
                            region.HandlerOffset,
                            region.HandlerLength,
                            if region.Kind == ExceptionRegionKind.Filter {
                                region.FilterOffset
                            } else {
                                -1
                            }
                        )
                    )
                }
                let il = body.GetILBytes() ?? Array.Empty[uint8]()
                var codeStart = -1
                for region in regions {
                    if region.Kind != ExceptionRegionKind.Filter ||
                        !IsFilterStartInsideFinallyOrFault(regions, region.FilterOffset) ||
                        !PopsExactlyOne(il, region.FilterOffset) {
                        continue
                    }
                    let patchLength = GetFilterPreludePatchLength(
                        reader,
                        il,
                        region.FilterOffset,
                        region.HandlerOffset,
                        body.MaxStack
                    )
                    if patchLength <= 0 {
                        return false
                    }
                    if codeStart < 0 {
                        codeStart = GetMethodCodeOffset(pe, bytes, method.RelativeVirtualAddress)
                        if codeStart < 0 {
                            return false
                        }
                    }
                    let op = il[region.FilterOffset]
                    let fileOffset = codeStart + region.FilterOffset
                    if op == uint8(0x75) || op == uint8(0x74) {
                        if patchLength < 6 {
                            return false
                        }
                        let token0 = il[region.FilterOffset + 1]
                        let token1 = il[region.FilterOffset + 2]
                        let token2 = il[region.FilterOffset + 3]
                        let token3 = il[region.FilterOffset + 4]
                        patched[fileOffset] = uint8(0x14)
                        patched[fileOffset + 1] = op
                        patched[fileOffset + 2] = token0
                        patched[fileOffset + 3] = token1
                        patched[fileOffset + 4] = token2
                        patched[fileOffset + 5] = token3
                        for var k = 6; k < patchLength; k++ {
                            patched[fileOffset + k] = uint8(0x00)
                        }
                        patchedAny = true
                    } else if op == uint8(0x26) {
                        patched[fileOffset] = uint8(0x00)
                        patchedAny = true
                    } else {
                        return false
                    }
                }
            }
            return patchedAny
        }

        private func GetMethodCodeOffset(pe PEReader, bytes[]uint8, rva int32) int32 {
            for section in pe.PEHeaders.SectionHeaders {
                if rva >= section.VirtualAddress && rva < section.VirtualAddress + section.SizeOfRawData {
                    let headerOffset = rva - section.VirtualAddress + section.PointerToRawData
                    if headerOffset < 0 || headerOffset >= bytes.Length {
                        return -1
                    }
                    let isTiny = (int32(bytes[headerOffset]) & 0x3) == 0x2
                    if !isTiny && headerOffset + 1 >= bytes.Length {
                        return -1
                    }
                    let headerSize = if isTiny {
                        1
                    } else {
                        (int32(bytes[headerOffset + 1]) >> 4) * 4
                    }
                    let codeStart = headerOffset + headerSize
                    return if codeStart >= 0 && codeStart <= bytes.Length {
                        codeStart
                    } else {
                        -1
                    }
                }
            }
            return -1
        }

        /// Issue #5115: checks that the filter region `[filterOffset, handlerOffset)`
        /// starts with a patchable instruction (`isinst`/`castclass` with a valid type
        /// token, or `pop`), decodes cleanly up to `endfilter`, and maintains a valid
        /// evaluation stack depth along every path inside the filter starting from the
        /// CLR's 1-item exception stack.
        private func CanPatchAndVerifyFilterRegion(
            reader MetadataReader,
            il[]uint8,
            filterOffset int32,
            handlerOffset int32,
            maxStack int32
        ) bool {
            return GetFilterPreludePatchLength(reader, il, filterOffset, handlerOffset, maxStack) > 0
        }

        private func GetFilterPreludePatchLength(
            reader MetadataReader,
            il[]uint8,
            filterOffset int32,
            handlerOffset int32,
            maxStack int32
        ) int32 {
            if maxStack < 1 || filterOffset < 0 || handlerOffset <= filterOffset + 2 || handlerOffset > il.Length {
                return 0
            }
            if il[handlerOffset - 2] != uint8(0xFE) || il[handlerOffset - 1] != uint8(0x11) {
                return 0
            }
            let instructionStarts = HashSet[int32]()
            let allBranchTargets = HashSet[int32]()
            var scan = filterOffset
            while scan < handlerOffset {
                instructionStarts.Add(scan)
                let decodedScan = DecodeInstruction(il, scan, handlerOffset)
                if !decodedScan.Decoded {
                    return 0
                }
                let scanBranchTargets = decodedScan.BranchTargets
                if scanBranchTargets != nil {
                    for target in scanBranchTargets {
                        allBranchTargets.Add(target)
                    }
                }
                scan = decodedScan.NextOffset
            }
            if scan != handlerOffset {
                return 0
            }
            let patchLength = MatchFilterEntryPrelude(reader, il, filterOffset, handlerOffset, allBranchTargets)
            if patchLength <= 0 {
                return 0
            }
            let depths = Dictionary[int32, int32]()
            let worklist = Queue[int32]()
            depths[filterOffset] = 1
            worklist.Enqueue(filterOffset)
            var reachedEndfilter = false
            while worklist.Count > 0 {
                let pc = worklist.Dequeue()
                let depth = depths[pc]
                let decoded = DecodeInstruction(il, pc, handlerOffset)
                if !decoded.Decoded {
                    return 0
                }
                let opcode = decoded.OpCode
                let nextPc = decoded.NextOffset
                let branchTargets = decoded.BranchTargets
                let metadataToken = decoded.MetadataToken
                if !TryGetStackDelta(reader, opcode, metadataToken, out var pops, out var pushes) {
                    return 0
                }
                if depth < pops {
                    return 0
                }
                let nextDepth = depth - pops + pushes
                if nextDepth > maxStack {
                    return 0
                }
                if opcode == OpCodes.Endfilter {
                    if depth != 1 || nextDepth != 0 {
                        return 0
                    }
                    reachedEndfilter = true
                    continue
                }
                if opcode.FlowControl == FlowControl.Return || opcode.FlowControl == FlowControl.Throw {
                    continue
                }
                if branchTargets != nil {
                    for target in branchTargets {
                        if !instructionStarts.Contains(target) {
                            return 0
                        }
                        if depths.TryGetValue(target, out var existingTargetDepth) {
                            if existingTargetDepth != nextDepth {
                                return 0
                            }
                        } else {
                            depths[target] = nextDepth
                            worklist.Enqueue(target)
                        }
                    }
                }
                if opcode.FlowControl != FlowControl.Branch {
                    if nextPc >= handlerOffset || !instructionStarts.Contains(nextPc) {
                        return 0
                    }
                    if depths.TryGetValue(nextPc, out var existingNextDepth) {
                        if existingNextDepth != nextDepth {
                            return 0
                        }
                    } else {
                        depths[nextPc] = nextDepth
                        worklist.Enqueue(nextPc)
                    }
                }
            }
            return if reachedEndfilter {
                patchLength
            } else {
                0
            }
        }

        private func MatchFilterEntryPrelude(
            reader MetadataReader,
            il[]uint8,
            filterOffset int32,
            handlerOffset int32,
            allBranchTargets HashSet[int32]
        ) int32 {
            let firstOp = il[filterOffset]
            if firstOp == uint8(0x26) {
                return 1
            }
            if firstOp != uint8(0x75) && firstOp != uint8(0x74) {
                return 0
            }
            if filterOffset +
                5 > handlerOffset ||
                !IsValidTypeToken(reader, BitConverter.ToInt32(il, filterOffset + 1)) {
                return 0
            }
            if filterOffset + 6 <= handlerOffset && il[filterOffset + 5] == uint8(0x00) && !allBranchTargets.Contains(
                filterOffset + 5
            ) {
                return 6
            }
            var cursor = filterOffset + 5
            if cursor >= handlerOffset || il[cursor] != uint8(0x25) {
                return 0
            }
            cursor += 1
            let decodedBrtrue = DecodeInstruction(il, cursor, handlerOffset)
            let brtrueTargets = decodedBrtrue.BranchTargets
            if !decodedBrtrue.Decoded ||
                (decodedBrtrue.OpCode != OpCodes.Brtrue_S && decodedBrtrue.OpCode != OpCodes.Brtrue) ||
                brtrueTargets == nil ||
                brtrueTargets.Count != 1 {
                return 0
            }
            let matchedOffset = brtrueTargets[0]
            cursor = decodedBrtrue.NextOffset
            if cursor + 2 > handlerOffset || il[cursor] != uint8(0x26) || il[cursor + 1] != uint8(0x16) {
                return 0
            }
            cursor += 2
            let decodedBr = DecodeInstruction(il, cursor, handlerOffset)
            let brTargets = decodedBr.BranchTargets
            if !decodedBr.Decoded ||
                (decodedBr.OpCode != OpCodes.Br_S && decodedBr.OpCode != OpCodes.Br) ||
                brTargets == nil ||
                brTargets.Count != 1 {
                return 0
            }
            let doneOffset = brTargets[0]
            cursor = decodedBr.NextOffset
            if cursor != matchedOffset || matchedOffset >= handlerOffset - 2 || doneOffset != handlerOffset - 2 {
                return 0
            }
            for var offset = filterOffset + 1; offset < matchedOffset; offset++ {
                if allBranchTargets.Contains(offset) {
                    return 0
                }
            }
            return matchedOffset - filterOffset
        }

        private func IsValidTypeToken(reader MetadataReader, token int32) bool {
            let tableByte = int32((uint32(token) >> 24) & uint32(0xFF))
            if tableByte != 0x01 && tableByte != 0x02 && tableByte != 0x1B {
                return false
            }
            try {
                let handle = MetadataTokens.EntityHandle(token)
                if handle.IsNil {
                    return false
                }
                let row = MetadataTokens.GetRowNumber(handle)
                return switch handle.Kind {
                    case HandleKind.TypeDefinition: row >= 1 && row <= reader.GetTableRowCount(TableIndex.TypeDef)
                    case HandleKind.TypeReference: row >= 1 && row <= reader.GetTableRowCount(TableIndex.TypeRef)
                    case HandleKind.TypeSpecification: row >= 1 && row <= reader.GetTableRowCount(TableIndex.TypeSpec)
                    default: false
                }
            } catch (ArgumentException) {
                return false
            } catch (BadImageFormatException) {
                return false
            }
        }

        private func DecodeInstruction(il[]uint8, offset int32, limit int32)(
            Decoded bool,
            OpCode OpCode,
            NextOffset int32,
            BranchTargets List[int32]?,
            MetadataToken int32?
        ) {
            var branchTargets List[int32]? = nil
            var metadataToken int32? = nil
            if offset < 0 || offset >= limit {
                return (false, OpCodes.Nop, offset, nil, nil)
            }
            var cursor = offset
            var rawValue int16
            if il[cursor++] == uint8(0xFE) {
                if cursor >= limit {
                    return (false, OpCodes.Nop, offset, nil, nil)
                }
                rawValue = unchecked(int16((0xFE00 | int32(il[cursor++]))))
            } else {
                rawValue = unchecked(int16(il[offset]))
            }
            if !OpCodesByValue.TryGetValue(rawValue, out var opcode) {
                return (false, OpCodes.Nop, offset, nil, nil)
            }
            switch opcode.OperandType {
                case OperandType.InlineNone { }
                case OperandType.ShortInlineBrTarget {
                    if cursor + 1 > limit {
                        return (false, opcode, offset, nil, nil)
                    }
                    let delta = int32(unchecked(int8(il[cursor])))
                    cursor += 1
                    branchTargets = List[int32]{cursor + delta}
                }
                case OperandType.InlineBrTarget {
                    if cursor + 4 > limit {
                        return (false, opcode, offset, nil, nil)
                    }
                    let delta = BitConverter.ToInt32(il, cursor)
                    cursor += 4
                    branchTargets = List[int32]{cursor + delta}
                }
                case OperandType.InlineSwitch {
                    if cursor + 4 > limit {
                        return (false, opcode, offset, nil, nil)
                    }
                    let count = BitConverter.ToInt32(il, cursor)
                    let remainingAfterCount = limit - (cursor + 4)
                    if count < 0 || count > remainingAfterCount / 4 {
                        return (false, opcode, offset, nil, nil)
                    }
                    let baseOffset = cursor + 4 + (count * 4)
                    let targets = List[int32](count)
                    for var i = 0; i < count; i++ {
                        targets.Add(baseOffset + BitConverter.ToInt32(il, cursor + 4 + (i * 4)))
                    }
                    cursor = baseOffset
                    branchTargets = targets
                }
                case OperandType.ShortInlineI, OperandType.ShortInlineVar {
                    cursor += 1
                }
                case OperandType.InlineVar {
                    cursor += 2
                }
                case OperandType.InlineMethod,
                OperandType.InlineField,
                OperandType.InlineSig,
                OperandType.InlineString,
                OperandType.InlineTok,
                OperandType
                    .InlineType {
                    if cursor + 4 > limit {
                        return (false, opcode, offset, nil, nil)
                    }
                    metadataToken = BitConverter.ToInt32(il, cursor)
                    cursor += 4
                }
                case OperandType.InlineI, OperandType.ShortInlineR {
                    cursor += 4
                }
                case OperandType.InlineI8, OperandType.InlineR {
                    cursor += 8
                }
                default {
                    return (false, opcode, offset, nil, nil)
                }
            }
            if cursor > limit {
                return (false, opcode, offset, nil, nil)
            }
            return (true, opcode, cursor, branchTargets, metadataToken)
        }

        private func TryGetStackDelta(
            reader MetadataReader,
            opcode OpCode,
            metadataToken int32?,
            out pops int32,
            out pushes int32
        ) bool {
            pops = 0
            pushes = 0
            if opcode.StackBehaviourPop == StackBehaviour.Varpop ||
                opcode.StackBehaviourPush == StackBehaviour
                .Varpush {
                if metadataToken == nil {
                    return false
                }
                return TryGetCallStackDelta(reader, opcode, metadataToken, out pops, out pushes)
            }
            pops = switch opcode.StackBehaviourPop {
                case StackBehaviour.Pop0: 0
                case StackBehaviour.Pop1, StackBehaviour.Popi, StackBehaviour.Popref: 1
                case StackBehaviour.Pop1_pop1,
                StackBehaviour.Popi_pop1,
                StackBehaviour.Popi_popi,
                StackBehaviour.Popi_popi8,
                StackBehaviour.Popi_popr4,
                StackBehaviour.Popi_popr8,
                StackBehaviour.Popref_pop1,
                StackBehaviour.Popref_popi: 2
                case StackBehaviour.Popi_popi_popi,
                StackBehaviour.Popref_popi_popi,
                StackBehaviour.Popref_popi_popi8,
                StackBehaviour.Popref_popi_popr4,
                StackBehaviour.Popref_popi_popr8,
                StackBehaviour.Popref_popi_popref,
                StackBehaviour.Popref_popi_pop1: 3
                default: -1
            }
            pushes = switch opcode.StackBehaviourPush {
                case StackBehaviour.Push0: 0
                case StackBehaviour.Push1,
                StackBehaviour.Pushi,
                StackBehaviour.Pushi8,
                StackBehaviour.Pushr4,
                StackBehaviour.Pushr8,
                StackBehaviour.Pushref: 1
                case StackBehaviour.Push1_push1: 2
                default: -1
            }
            return pops >= 0 && pushes >= 0
        }

        private func TryGetCallStackDelta(
            reader MetadataReader,
            opcode OpCode,
            token int32,
            out pops int32,
            out pushes int32
        ) bool {
            pops = 0
            pushes = 0
            let tableByte = int32((uint32(token) >> 24) & uint32(0xFF))
            if tableByte != 0x06 && tableByte != 0x0A && tableByte != 0x2B {
                return false
            }
            try {
                var handle = MetadataTokens.EntityHandle(token)
                if handle.IsNil {
                    return false
                }
                if handle.Kind == HandleKind.MethodSpecification {
                    let row = MetadataTokens.GetRowNumber(handle)
                    if row < 1 || row > reader.GetTableRowCount(TableIndex.MethodSpec) {
                        return false
                    }
                    handle = reader.GetMethodSpecification(MethodSpecificationHandle(handle)).Method
                }
                var sigHandle = default(BlobHandle)
                if handle.Kind == HandleKind.MethodDefinition {
                    let row = MetadataTokens.GetRowNumber(handle)
                    if row < 1 || row > reader.GetTableRowCount(TableIndex.MethodDef) {
                        return false
                    }
                    sigHandle = reader.GetMethodDefinition(MethodDefinitionHandle(handle)).Signature
                } else if handle.Kind == HandleKind.MemberReference {
                    let row = MetadataTokens.GetRowNumber(handle)
                    if row < 1 || row > reader.GetTableRowCount(TableIndex.MemberRef) {
                        return false
                    }
                    sigHandle = reader.GetMemberReference(MemberReferenceHandle(handle)).Signature
                } else {
                    return false
                }
                var blob = reader.GetBlobReader(sigHandle)
                let header = blob.ReadSignatureHeader()
                if header.Kind != SignatureKind.Method {
                    return false
                }
                if header.IsGeneric {
                    blob.ReadCompressedInteger()
                }
                let paramCount = blob.ReadCompressedInteger()
                let isNewobj = opcode == OpCodes.Newobj
                let popThis = !isNewobj && header.IsInstance && !header.HasExplicitThis
                pops = paramCount +
                    (
                    if popThis {
                        1
                    } else {
                        0
                    }
                )
                // Skip custom modifiers on return type (`ELEMENT_TYPE_CMOD_REQD` 0x1F, `ELEMENT_TYPE_CMOD_OPT` 0x20).
                while blob.RemainingBytes > 0 {
                    let b = blob.ReadByte()
                    if b == uint8(0x1F) || b == uint8(0x20) {
                        blob.ReadCompressedInteger()
                        continue
                    }
                    let isVoid = b == uint8(0x01)
                    pushes = if isNewobj || !isVoid {
                        1
                    } else {
                        0
                    }
                    return true
                }
                return false
            } catch (ArgumentException) {
                return false
            } catch (BadImageFormatException) {
                return false
            }
        }

        /// Returns whether the instruction at [`offset`](paramref) pops exactly
        /// one stack value. ilverify models the filter's entry stack as empty, so an
        /// underflow at a one-pop first instruction is explained entirely by the
        /// missing exception object; an instruction that pops two (e.g. `add`)
        /// would underflow even with the object present, so it stays an error.
        /// gsc and Roslyn both open a filter with `isinst`. Unknown opcodes
        /// fail closed.
        /// @param il The method body's IL bytes.
        /// @param offset The instruction offset.
        /// @returns `true` for a known one-pop opcode.
        func PopsExactlyOne(il[]uint8, offset int32) bool {
            if offset < 0 || offset >= il.Length {
                return false
            }
            let op = il[offset]
            if op == uint8(0xFE) {
                // starg (FE 0B), stloc (FE 0E).
                return offset + 1 < il.Length && (il[offset + 1] == uint8(0x0B) || il[offset + 1] == uint8(0x0E))
            }
            return op == uint8(0x75) ||
                op == uint8(0x74) ||
                op == uint8(0x26) ||
                op == uint8(0x25) ||
                (op >= uint8(0x0A) && op <= uint8(0x0D)) ||
                op == uint8(0x13) ||
                op == uint8(0x10) // starg.s

        }

        /// Returns whether [`offset`](paramref) is the `FilterOffset` of a
        /// filter region in [`regions`](paramref) and the innermost handler
        /// region enclosing it is a `Finally` or `Fault` handler.
        /// @param regions One method body's exception regions.
        /// @param offset The IL offset ilverify reported.
        /// @returns `true` for the #4489 false-positive layout.
        func IsFilterStartInsideFinallyOrFault(regions IReadOnlyList[Region], offset int32) bool {
            var isFilterStart = false
            var innermostHandler Region? = nil
            for region in regions {
                if region.Kind == ExceptionRegionKind.Filter && region.FilterOffset == offset {
                    isFilterStart = true
                }
                // Handler ranges nest properly, so the smallest enclosing one is
                // the innermost (the block's HandlerIndex in ILVerify).
                if offset >= region.HandlerOffset &&
                    offset < region.HandlerOffset +
                    region.HandlerLength &&
                    (innermostHandler == nil || region.HandlerLength < innermostHandler.HandlerLength) {
                    innermostHandler = region
                }
            }
            return isFilterStart &&
                innermostHandler != nil &&
                (
                innermostHandler.Kind == ExceptionRegionKind.Finally ||
                    innermostHandler.Kind == ExceptionRegionKind.Fault
            )
        }

        /// Splits an ilverify error line into its declaring type,
        /// method-name-and-signature text, top-level parameter count and offset.
        /// @param errorLine The ilverify line.
        /// @param typePart The `Namespace.Outer+Inner` text.
        /// @param methodPart The text after `::` up to the signature.
        /// @param parameterCount The signature's top-level parameter count.
        /// @param offset The reported IL offset.
        /// @param expectedCode The required diagnostic category.
        /// @returns `true` when the line has that shape.
        internal func TryParse(
            errorLine string?,
            out typePart string,
            out methodPart string,
            out parameterCount int32,
            out offset int32,
            expectedCode string = "StackUnderflow"
        ) bool {
            typePart = string.Empty
            methodPart = string.Empty
            parameterCount = 0
            offset = 0
            let match = ErrorLine.Match((errorLine ?? string.Empty).Trim())
            if !match.Success || match.Groups["code"].Value != expectedCode || !int32.TryParse(
                match.Groups["offset"].Value,
                NumberStyles.HexNumber,
                CultureInfo.InvariantCulture,
                out offset
            ) {
                return false
            }
            // location is `<assembly path> : <Type>::<Method>(<sig>)`; take the part
            // after the last " : " so a Windows drive colon does not split it.
            let location = match.Groups["location"].Value
            let sep = location.LastIndexOf(" : ", StringComparison.Ordinal)
            let member = if sep >= 0 {
                location.Substring(sep + 3).Trim()
            } else {
                location.Trim()
            }
            let colons = member.IndexOf("::", StringComparison.Ordinal)
            if colons <= 0 || !member.EndsWith(")", StringComparison.Ordinal) {
                return false
            }
            typePart = member.Substring(0, colons)
            let rest = member.Substring(colons + 2)
            // The signature is the last balanced `( … )` group.
            var depth = 0
            var open_ = -1
            for var i = rest.Length - 1; i >= 0; i-- {
                if rest[i] == ')' {
                    depth++
                } else if rest[i] == '(' {
                    depth--
                    if depth == 0 {
                        open_ = i
                        break
                    }
                }
            }
            if open_ <= 0 {
                return false
            }
            methodPart = rest.Substring(0, open_)
            parameterCount = CountTopLevelParameters(rest.Substring(open_ + 1, rest.Length - open_ - 2))
            return true
        }

        private func CountTopLevelParameters(signature string) int32 {
            if signature.Trim().Length == 0 {
                return 0
            }
            var depth = 0
            var count = 1
            for c in signature {
                if c == '<' || c == '[' || c == '(' {
                    depth++
                } else if c == '>' || c == ']' || c == ')' {
                    depth--
                } else if c == ',' && depth == 0 {
                    count++
                }
            }
            return count
        }

        // ilverify may append a generic instantiation (`Foo`1<T>`, `M<T>`), so a
        // metadata name matches the rendered text exactly or as a `<`-suffixed
        // prefix. G# synthesized names (`<Program>`, `<closure_…>`) contain angle
        // brackets themselves, so nothing is stripped from the rendered text.
        internal func NameMatches(rendered string, metadataName string) bool -> string.Equals(
            rendered,
            metadataName,
            StringComparison.Ordinal
        ) ||
            (
            rendered.StartsWith(metadataName, StringComparison.Ordinal) &&
                rendered.Length > metadataName.Length &&
                rendered[metadataName.Length] == '<'
        )

        private func IdentityKey(reader MetadataReader, method MethodDefinition) string -> GetTypeName(
            reader,
            method.GetDeclaringType()
        ) +
            "::" +
            reader.GetString(method.Name) + "/" + GetParameterCount(reader, method).ToString(
            CultureInfo.InvariantCulture
        )

        // The Param table can omit parameters or carry a return-value row, so read
        // the count from the method signature blob instead.
        internal func GetParameterCount(reader MetadataReader, method MethodDefinition) int32 {
            var blob = reader.GetBlobReader(method.Signature)
            var header = blob.ReadSignatureHeader()
            if header.IsGeneric {
                blob.ReadCompressedInteger()
            }
            return blob.ReadCompressedInteger()
        }

        internal func GetTypeName(reader MetadataReader, handle TypeDefinitionHandle) string {
            let type = reader.GetTypeDefinition(handle)
            let name = reader.GetString(type.Name)
            let declaring = type.GetDeclaringType()
            if !declaring.IsNil {
                return GetTypeName(reader, declaring) + "+" + name
            }
            let ns = reader.GetString(type.Namespace)
            return if ns.Length == 0 {
                name
            } else {
                ns + "." + name
            }
        }
    }
}
