// <copyright file="StrongStaticReflectionCacheAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using Xunit;

namespace GSharp.InternalAnalyzers.Tests;

public sealed class StrongStaticReflectionCacheAnalyzerTests
{
    [Fact]
    public Task ReportsStaticTypeAssemblyAndModuleDictionaryKeys()
    {
        const string Source = """
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

class C
{
    private static readonly Dictionary<Type, string> [|TypeCache|] = new();
    private static readonly ConcurrentDictionary<Assembly, string> [|AssemblyCache|] = new();
    private static readonly Dictionary<Module, string> [|ModuleCache|] = new();
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(
            new StrongStaticReflectionCacheAnalyzer(),
            Source,
            "GSA0003",
            "GSA0003",
            "GSA0003");
    }

    [Fact]
    public Task IgnoresTypeSymbolsInstanceCachesTuplesAndNonMetadataNamespaces()
    {
        const string Source = """
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Symbols;

class TypeSymbol { }
class C
{
    private static readonly ConcurrentDictionary<TypeSymbol, string> SymbolCache = new();
    private static readonly ConcurrentDictionary<(Type Source, Type Target), string> TupleCache = new();
    private readonly Dictionary<Type, string> InstanceCache = new();
}

namespace GSharp.Core.CodeAnalysis.Syntax;

class SyntaxCache
{
    private static readonly ConcurrentDictionary<Type, string> ChildAccessorsByType = new();
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new StrongStaticReflectionCacheAnalyzer(), Source);
    }
}
