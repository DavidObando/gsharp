// <copyright file="StructFieldDefsReadAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using Xunit;

namespace GSharp.InternalAnalyzers.Tests;

public sealed class StructFieldDefsReadAnalyzerTests
{
    [Fact]
    public Task ReportsValueReadOutsideResolver()
    {
        const string Source = """
using System.Collections.Generic;

class FieldSymbol { }
class Cache { public Dictionary<FieldSymbol, int> StructFieldDefs = new(); }
class Emitter
{
    private readonly Cache cache = new();
    void Emit(FieldSymbol field)
    {
        var token = [|this.cache.StructFieldDefs[field]|];
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new StructFieldDefsReadAnalyzer(), Source, "GSA0001");
    }

    [Fact]
    public Task IgnoresWritesAndResolverReads()
    {
        const string Source = """
using System.Collections.Generic;

class FieldSymbol { }
class StructSymbol { }
class Cache { public Dictionary<FieldSymbol, int> StructFieldDefs = new(); }
class Emitter
{
    private readonly Cache cache = new();
    void Populate(FieldSymbol field, int handle)
    {
        this.cache.StructFieldDefs[field] = handle;
    }

    int ResolveFieldToken(StructSymbol symbol, FieldSymbol field)
        => this.cache.StructFieldDefs[field];

    int ResolveInterfaceFieldToken(StructSymbol symbol, FieldSymbol field)
        => this.cache.StructFieldDefs[field];

    bool Probe(FieldSymbol field)
        => this.cache.StructFieldDefs.TryGetValue(field, out _);
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new StructFieldDefsReadAnalyzer(), Source);
    }
}
