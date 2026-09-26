// <copyright file="IlVerifyFilterInFinallyRule.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.RegularExpressions;

namespace GSharp.Tests;

/// <summary>
/// Recognizes one known <c>dotnet-ilverify</c> 10.0.8 false positive (#4489,
/// upstream https://github.com/dotnet/runtime/issues/134711): a
/// <c>StackUnderflow</c> reported at the first instruction of an exception
/// FILTER block whose start lies physically inside a <c>finally</c> or
/// <c>fault</c> handler.
///
/// Root cause: ILVerify's <c>StartImportingBasicBlock</c> checks a block's
/// <c>HandlerIndex</c> before its <c>FilterIndex</c>, so a filter start that
/// sits inside a finally/fault handler inherits that handler's empty entry
/// stack instead of the exception object the CLR pushes. (Inside a catch
/// handler it inherits the catch's exception type, which happens to verify.)
/// Roslyn's IL for the same C# fails identically, and the code runs correctly.
///
/// The rule is deliberately narrow. It never ignores <c>StackUnderflow</c> as a
/// category: the reported method must resolve in the assembly's metadata, the
/// reported method identity (type, name, parameter count) must be unique in
/// the assembly, the reported offset must equal one of its filter regions'
/// <c>FilterOffset</c>, the instruction there must pop exactly one value, and
/// the innermost handler region enclosing that offset must be <c>Finally</c>
/// or <c>Fault</c>. Anything else, including a line this class cannot parse or
/// resolve, stays an error.
///
/// Shared (linked source) between the Compiler.Tests <c>IlVerifier</c> and the
/// cs2gs self-migration <c>IlVerifyRunner</c>.
/// </summary>
internal sealed class IlVerifyFilterInFinallyRule
{
    private const string StackUnderflowCode = "StackUnderflow";

    // [IL]: Error [StackUnderflow]: [<asm> : <Type>::<Method>(<sig>)][offset 0x000001C6] Stack underflow.
    // The location is lazy so `]` inside array signatures does not end it early.
    private static readonly Regex StackUnderflowLine = new Regex(
        @"^\[IL\]:\s*Error\s*\[StackUnderflow\]:\s*\[(?<location>.*?)\]\s*\[offset 0x(?<offset>[0-9A-Fa-f]+)\]",
        RegexOptions.CultureInvariant);

    private readonly List<CandidateMethod> candidates;

    private IlVerifyFilterInFinallyRule(List<CandidateMethod> candidates)
    {
        this.candidates = candidates;
    }

    /// <summary>
    /// Reads <paramref name="assemblyPath"/>'s method bodies and records every
    /// filter start that the ILVerify bug misreports. Returns a rule that
    /// matches nothing when the file is missing or is not a readable
    /// ECMA-335 image (fail-safe: the errors then stay errors).
    /// </summary>
    /// <param name="assemblyPath">The verified assembly.</param>
    /// <returns>The rule for that assembly.</returns>
    public static IlVerifyFilterInFinallyRule Load(string? assemblyPath)
    {
        var found = new List<CandidateMethod>();
        if (string.IsNullOrEmpty(assemblyPath) || !File.Exists(assemblyPath))
        {
            return new IlVerifyFilterInFinallyRule(found);
        }

        try
        {
            using (FileStream stream = File.OpenRead(assemblyPath))
            using (var pe = new PEReader(stream))
            {
                if (!pe.HasMetadata)
                {
                    return new IlVerifyFilterInFinallyRule(found);
                }

                MetadataReader reader = pe.GetMetadataReader();

                // An ilverify line names a method only by type, name and
                // parameter list, so same-arity overloads are indistinguishable.
                // Fail closed: a method whose identity is shared by another
                // MethodDef in the assembly never becomes a candidate.
                var identityCounts = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (MethodDefinitionHandle handle in reader.MethodDefinitions)
                {
                    string key = IdentityKey(reader, reader.GetMethodDefinition(handle));
                    identityCounts.TryGetValue(key, out int count);
                    identityCounts[key] = count + 1;
                }

                foreach (MethodDefinitionHandle handle in reader.MethodDefinitions)
                {
                    MethodDefinition method = reader.GetMethodDefinition(handle);
                    if (method.RelativeVirtualAddress == 0
                        || identityCounts[IdentityKey(reader, method)] != 1)
                    {
                        continue;
                    }

                    MethodBodyBlock body = pe.GetMethodBody(method.RelativeVirtualAddress);
                    var regions = new List<Region>();
                    foreach (ExceptionRegion region in body.ExceptionRegions)
                    {
                        regions.Add(new Region(
                            region.Kind,
                            region.TryOffset,
                            region.TryLength,
                            region.HandlerOffset,
                            region.HandlerLength,
                            region.Kind == ExceptionRegionKind.Filter ? region.FilterOffset : -1));
                    }

                    byte[] il = body.GetILBytes() ?? Array.Empty<byte>();
                    var offsets = new List<int>();
                    foreach (Region region in regions)
                    {
                        if (region.Kind == ExceptionRegionKind.Filter
                            && IsFilterStartInsideFinallyOrFault(regions, region.FilterOffset)
                            && PopsExactlyOne(il, region.FilterOffset))
                        {
                            offsets.Add(region.FilterOffset);
                        }
                    }

                    if (offsets.Count == 0)
                    {
                        continue;
                    }

                    found.Add(new CandidateMethod(
                        GetTypeName(reader, method.GetDeclaringType()),
                        reader.GetString(method.Name),
                        GetParameterCount(reader, method),
                        offsets));
                }
            }
        }
        catch (BadImageFormatException)
        {
            found.Clear();
        }

        return new IlVerifyFilterInFinallyRule(found);
    }

    /// <summary>
    /// Returns whether the instruction at <paramref name="offset"/> pops exactly
    /// one stack value. ilverify models the filter's entry stack as empty, so an
    /// underflow at a one-pop first instruction is explained entirely by the
    /// missing exception object; an instruction that pops two (e.g. <c>add</c>)
    /// would underflow even with the object present, so it stays an error.
    /// gsc and Roslyn both open a filter with <c>isinst</c>. Unknown opcodes
    /// fail closed.
    /// </summary>
    /// <param name="il">The method body's IL bytes.</param>
    /// <param name="offset">The instruction offset.</param>
    /// <returns><see langword="true"/> for a known one-pop opcode.</returns>
    public static bool PopsExactlyOne(byte[] il, int offset)
    {
        if (offset < 0 || offset >= il.Length)
        {
            return false;
        }

        byte op = il[offset];
        if (op == 0xFE)
        {
            // starg (FE 0B), stloc (FE 0E).
            return offset + 1 < il.Length && (il[offset + 1] == 0x0B || il[offset + 1] == 0x0E);
        }

        return op == 0x75 // isinst
            || op == 0x74 // castclass
            || op == 0x26 // pop
            || op == 0x25 // dup
            || (op >= 0x0A && op <= 0x0D) // stloc.0 .. stloc.3
            || op == 0x13 // stloc.s
            || op == 0x10; // starg.s
    }

    /// <summary>
    /// Returns whether <paramref name="offset"/> is the <c>FilterOffset</c> of a
    /// filter region in <paramref name="regions"/> and the innermost handler
    /// region enclosing it is a <c>Finally</c> or <c>Fault</c> handler.
    /// </summary>
    /// <param name="regions">One method body's exception regions.</param>
    /// <param name="offset">The IL offset ilverify reported.</param>
    /// <returns><see langword="true"/> for the #4489 false-positive layout.</returns>
    public static bool IsFilterStartInsideFinallyOrFault(IReadOnlyList<Region> regions, int offset)
    {
        bool isFilterStart = false;
        Region? innermostHandler = null;
        foreach (Region region in regions)
        {
            if (region.Kind == ExceptionRegionKind.Filter && region.FilterOffset == offset)
            {
                isFilterStart = true;
            }

            // Handler ranges nest properly, so the smallest enclosing one is
            // the innermost (the block's HandlerIndex in ILVerify).
            if (offset >= region.HandlerOffset
                && offset < region.HandlerOffset + region.HandlerLength
                && (innermostHandler is null || region.HandlerLength < innermostHandler.HandlerLength))
            {
                innermostHandler = region;
            }
        }

        return isFilterStart
            && innermostHandler is not null
            && (innermostHandler.Kind == ExceptionRegionKind.Finally
                || innermostHandler.Kind == ExceptionRegionKind.Fault);
    }

    /// <summary>
    /// Returns whether <paramref name="errorLine"/> is an ilverify
    /// <c>StackUnderflow</c> line for a method and offset recorded by
    /// <see cref="Load"/>.
    /// </summary>
    /// <param name="errorCode">The parsed error code, when the caller has it; a
    /// non-<c>StackUnderflow</c> code never matches.</param>
    /// <param name="errorLine">The trimmed ilverify error line.</param>
    /// <returns><see langword="true"/> when the line is the #4489 false positive.</returns>
    public bool Matches(string? errorCode, string? errorLine)
    {
        if (this.candidates.Count == 0
            || (errorCode is not null && !string.Equals(errorCode, StackUnderflowCode, StringComparison.Ordinal))
            || !TryParse(errorLine, out string typePart, out string methodPart, out int parameterCount, out int offset))
        {
            return false;
        }

        foreach (CandidateMethod candidate in this.candidates)
        {
            if (candidate.ParameterCount == parameterCount
                && candidate.FilterOffsets.Contains(offset)
                && NameMatches(typePart, candidate.TypeName)
                && NameMatches(methodPart, candidate.MethodName))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Splits an ilverify <c>StackUnderflow</c> line into its declaring type,
    /// method-name-and-signature text, top-level parameter count and offset.
    /// </summary>
    /// <param name="errorLine">The ilverify line.</param>
    /// <param name="typePart">The <c>Namespace.Outer+Inner</c> text.</param>
    /// <param name="methodPart">The text after <c>::</c> up to the signature.</param>
    /// <param name="parameterCount">The signature's top-level parameter count.</param>
    /// <param name="offset">The reported IL offset.</param>
    /// <returns><see langword="true"/> when the line has that shape.</returns>
    internal static bool TryParse(
        string? errorLine,
        out string typePart,
        out string methodPart,
        out int parameterCount,
        out int offset)
    {
        typePart = string.Empty;
        methodPart = string.Empty;
        parameterCount = 0;
        offset = 0;
        Match match = StackUnderflowLine.Match((errorLine ?? string.Empty).Trim());
        if (!match.Success
            || !int.TryParse(match.Groups["offset"].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out offset))
        {
            return false;
        }

        // location is `<assembly path> : <Type>::<Method>(<sig>)`; take the part
        // after the last " : " so a Windows drive colon does not split it.
        string location = match.Groups["location"].Value;
        int sep = location.LastIndexOf(" : ", StringComparison.Ordinal);
        string member = sep >= 0 ? location.Substring(sep + 3).Trim() : location.Trim();
        int colons = member.IndexOf("::", StringComparison.Ordinal);
        if (colons <= 0 || !member.EndsWith(")", StringComparison.Ordinal))
        {
            return false;
        }

        typePart = member.Substring(0, colons);
        string rest = member.Substring(colons + 2);

        // The signature is the last balanced `( … )` group.
        int depth = 0;
        int open = -1;
        for (int i = rest.Length - 1; i >= 0; i--)
        {
            if (rest[i] == ')')
            {
                depth++;
            }
            else if (rest[i] == '(')
            {
                depth--;
                if (depth == 0)
                {
                    open = i;
                    break;
                }
            }
        }

        if (open <= 0)
        {
            return false;
        }

        methodPart = rest.Substring(0, open);
        parameterCount = CountTopLevelParameters(rest.Substring(open + 1, rest.Length - open - 2));
        return true;
    }

    private static int CountTopLevelParameters(string signature)
    {
        if (signature.Trim().Length == 0)
        {
            return 0;
        }

        int depth = 0;
        int count = 1;
        foreach (char c in signature)
        {
            if (c == '<' || c == '[' || c == '(')
            {
                depth++;
            }
            else if (c == '>' || c == ']' || c == ')')
            {
                depth--;
            }
            else if (c == ',' && depth == 0)
            {
                count++;
            }
        }

        return count;
    }

    // ilverify may append a generic instantiation (`Foo`1<T>`, `M<T>`), so a
    // metadata name matches the rendered text exactly or as a `<`-suffixed
    // prefix. G# synthesized names (`<Program>`, `<closure_…>`) contain angle
    // brackets themselves, so nothing is stripped from the rendered text.
    private static bool NameMatches(string rendered, string metadataName) =>
        string.Equals(rendered, metadataName, StringComparison.Ordinal)
        || (rendered.StartsWith(metadataName, StringComparison.Ordinal)
            && rendered.Length > metadataName.Length
            && rendered[metadataName.Length] == '<');

    private static string IdentityKey(MetadataReader reader, MethodDefinition method) =>
        GetTypeName(reader, method.GetDeclaringType()) + "::" + reader.GetString(method.Name) + "/" +
        GetParameterCount(reader, method).ToString(CultureInfo.InvariantCulture);

    // The Param table can omit parameters or carry a return-value row, so read
    // the count from the method signature blob instead.
    private static int GetParameterCount(MetadataReader reader, MethodDefinition method)
    {
        BlobReader blob = reader.GetBlobReader(method.Signature);
        SignatureHeader header = blob.ReadSignatureHeader();
        if (header.IsGeneric)
        {
            blob.ReadCompressedInteger();
        }

        return blob.ReadCompressedInteger();
    }

    private static string GetTypeName(MetadataReader reader, TypeDefinitionHandle handle)
    {
        TypeDefinition type = reader.GetTypeDefinition(handle);
        string name = reader.GetString(type.Name);
        TypeDefinitionHandle declaring = type.GetDeclaringType();
        if (!declaring.IsNil)
        {
            return GetTypeName(reader, declaring) + "+" + name;
        }

        string ns = reader.GetString(type.Namespace);
        return ns.Length == 0 ? name : ns + "." + name;
    }

    /// <summary>One exception region of a method body (test-constructible).</summary>
    internal sealed class Region
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="Region"/> class.
        /// </summary>
        /// <param name="kind">The region kind.</param>
        /// <param name="tryOffset">The protected block's start.</param>
        /// <param name="tryLength">The protected block's length.</param>
        /// <param name="handlerOffset">The handler block's start.</param>
        /// <param name="handlerLength">The handler block's length.</param>
        /// <param name="filterOffset">The filter block's start, or -1.</param>
        public Region(
            ExceptionRegionKind kind,
            int tryOffset,
            int tryLength,
            int handlerOffset,
            int handlerLength,
            int filterOffset)
        {
            this.Kind = kind;
            this.TryOffset = tryOffset;
            this.TryLength = tryLength;
            this.HandlerOffset = handlerOffset;
            this.HandlerLength = handlerLength;
            this.FilterOffset = filterOffset;
        }

        /// <summary>Gets the region kind.</summary>
        public ExceptionRegionKind Kind { get; }

        /// <summary>Gets the protected block's start.</summary>
        public int TryOffset { get; }

        /// <summary>Gets the protected block's length.</summary>
        public int TryLength { get; }

        /// <summary>Gets the handler block's start.</summary>
        public int HandlerOffset { get; }

        /// <summary>Gets the handler block's length.</summary>
        public int HandlerLength { get; }

        /// <summary>Gets the filter block's start, or -1 for non-filter regions.</summary>
        public int FilterOffset { get; }
    }

    private sealed class CandidateMethod
    {
        public CandidateMethod(string typeName, string methodName, int parameterCount, List<int> filterOffsets)
        {
            this.TypeName = typeName;
            this.MethodName = methodName;
            this.ParameterCount = parameterCount;
            this.FilterOffsets = filterOffsets;
        }

        public string TypeName { get; }

        public string MethodName { get; }

        public int ParameterCount { get; }

        public List<int> FilterOffsets { get; }
    }
}
