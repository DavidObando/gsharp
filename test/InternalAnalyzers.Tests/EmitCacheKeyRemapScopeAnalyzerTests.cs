// <copyright file="EmitCacheKeyRemapScopeAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using Xunit;

namespace GSharp.InternalAnalyzers.Tests;

public sealed class EmitCacheKeyRemapScopeAnalyzerTests
{
    private const string Prelude = """
using System.Collections.Generic;

namespace System.Reflection.Metadata
{
    public struct EntityHandle { }
    public struct MemberReferenceHandle { }
    public struct TypeSpecificationHandle { }
    public struct MethodSpecificationHandle { }
    public struct TypeDefinitionHandle { }
    public struct MethodDefinitionHandle { }
    public struct FieldDefinitionHandle { }
}

namespace GSharp.Core.CodeAnalysis.Symbols
{
    public class TypeSymbol { }
    public class StructSymbol { }
    public class TypeParameterSymbol { }
    public class FunctionSymbol { }
}

""";

    [Fact]
    public Task ReportsSymbolKeyedReferenceCachesWithoutRemapScope()
    {
        const string Source = Prelude + """
namespace GSharp.Core.CodeAnalysis.Emit
{
    using System.Reflection.Metadata;
    using GSharp.Core.CodeAnalysis.Symbols;

    internal readonly struct RemapScope { }

    internal readonly struct BadCompositeKey
    {
        private readonly TypeSymbol[] typeArgs;

        public BadCompositeKey(TypeSymbol[] typeArgs) => this.typeArgs = typeArgs;
    }

    internal sealed class Caches
    {
        private readonly Dictionary<StructSymbol, MemberReferenceHandle> [|plainSymbolCache|] = new();
        private readonly Dictionary<(StructSymbol Sym, object ClassRemap, object MethodRemap), EntityHandle> [|objectTupleCache|] = new();
        private readonly Dictionary<BadCompositeKey, MethodSpecificationHandle> [|compositeKeyCache|] = new();

        public Dictionary<TypeParameterSymbol, MemberReferenceHandle> [|NullableCtorRefs|] { get; } = new();
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(
            new EmitCacheKeyRemapScopeAnalyzer(),
            Source,
            "GSA0004",
            "GSA0004",
            "GSA0004",
            "GSA0004");
    }

    [Fact]
    public Task IgnoresScopedKeysDefinitionHandlesAndNonSymbolKeys()
    {
        const string Source = Prelude + """
namespace GSharp.Core.CodeAnalysis.Emit
{
    using System.Reflection.Metadata;
    using GSharp.Core.CodeAnalysis.Symbols;

    internal readonly struct RemapScope { }

    internal readonly struct ScopedCompositeKey
    {
        private readonly TypeSymbol[] typeArgs;
        private readonly RemapScope scope;

        public ScopedCompositeKey(TypeSymbol[] typeArgs, RemapScope scope)
        {
            this.typeArgs = typeArgs;
            this.scope = scope;
        }
    }

    internal sealed class Caches
    {
        // Key carries the remap scope: the invariant is satisfied.
        private readonly Dictionary<(StructSymbol Sym, RemapScope Scope), EntityHandle> scopedTupleCache = new();
        private readonly Dictionary<ScopedCompositeKey, MethodSpecificationHandle> scopedCompositeCache = new();

        // Definition rows are scope-invariant: one row per symbol.
        private readonly Dictionary<StructSymbol, TypeDefinitionHandle> typeDefCache = new();
        private readonly Dictionary<FunctionSymbol, MethodDefinitionHandle> methodDefCache = new();

        // Non-symbol keys carry no symbolic type parameters.
        private readonly Dictionary<string, MemberReferenceHandle> stringKeyedCache = new();

        // Non-handle values are not metadata rows.
        private readonly Dictionary<FunctionSymbol, TypeParameterSymbol[]> symbolToSymbolsCache = new();

        public Dictionary<(TypeParameterSymbol Tp, RemapScope Scope), MemberReferenceHandle> ScopedProperty { get; } = new();
    }
}

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System.Reflection.Metadata;
    using GSharp.Core.CodeAnalysis.Symbols;

    // Outside the Emit namespace: not this rule's concern.
    internal sealed class OtherLayer
    {
        private readonly Dictionary<StructSymbol, MemberReferenceHandle> notEmit = new();
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new EmitCacheKeyRemapScopeAnalyzer(), Source);
    }
}
