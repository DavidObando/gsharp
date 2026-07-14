// <copyright file="ReflectionTypeComparisonAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using Xunit;

namespace GSharp.InternalAnalyzers.Tests;

public sealed class ReflectionTypeComparisonAnalyzerTests
{
    [Fact]
    public Task ReportsTypeofReferenceComparisonsInCompilerMetadataNamespaces()
    {
        const string Source = """
using System;

namespace GSharp.Core.CodeAnalysis.Binding
{
    class C
    {
        bool EqualsTypeof(Type type) => [|type == typeof(string)|];
        bool NotEqualsTypeof(Type type) => [|typeof(int) != type|];
        bool ReferenceEqualsTypeof(Type type) => [|ReferenceEquals(type, typeof(string))|];
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(
            new ReflectionTypeComparisonAnalyzer(),
            Source,
            "GSA0002",
            "GSA0002",
            "GSA0002");
    }

    [Fact]
    public Task IgnoresTypeVariablesSymbolsNullsAndExemptUtilityTypes()
    {
        const string Source = """
using System;

namespace GSharp.Core.CodeAnalysis.Symbols
{
    class Symbol { }
    class C
    {
        bool Same(Symbol a, Symbol b) => ReferenceEquals(a, b) || a == b;
        bool SameTypes(Type a, Type b) => ReferenceEquals(a, b) || a == b || a != b;
        bool NullCheck(Type a) => a == null || null != a;
    }

    class ClrTypeUtilities
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(int);
    }

    class TypeIdentityComparer
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(int);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new ReflectionTypeComparisonAnalyzer(), Source);
    }

    [Fact]
    public Task IgnoresTypeofComparisonsOutsideCompilerMetadataNamespaces()
    {
        const string Source = """
using System;

namespace GSharp.Core.CodeAnalysis.Syntax
{
    class C
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(string);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new ReflectionTypeComparisonAnalyzer(), Source);
    }
}
