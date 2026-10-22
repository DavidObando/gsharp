// <copyright file="IlVerifyFilterInFinallyRule.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Tests

import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Reflection.Metadata
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
                                    PopsExactlyOne(il, region.FilterOffset) {
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
