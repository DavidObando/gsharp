// <copyright file="ClrConstructorCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 4 exit — CLR class instantiation at call sites. Covers both
/// non-generic (<c>StringBuilder()</c>) and closed-generic
/// (<c>List[int]()</c>, <c>Dictionary[string, int]()</c>) imports through
/// the new <see cref="BoundClrConstructorCallExpression"/>.
/// </summary>
public class ClrConstructorCallTests
{
    [Fact]
    public void StringBuilder_DefaultConstructor_Binds()
    {
        var source = @"
import System.Text

var sb = StringBuilder()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ListInt_DefaultConstructor_Binds()
    {
        var source = @"
import System.Collections.Generic

var lst = List[int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ListInt_WithNestedNonGenericSourceHomonym_BindsImportedGeneric()
    {
        var source = @"
package Demo
import System.Collections.Generic

class DocInline {
    class List {}
}

var lst = List[int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ImportedTopLevelType_WithSameArityNestedSourceHomonym_BindsImportedType()
    {
        var source = @"
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedService {}
}

class Consumer {
    shared {
        func Read() int32 {
            let service = Issue3466ImportedService()
            return service.Value
        }
    }
}

var value = Consumer.Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DictionaryStringInt_DefaultConstructor_Binds()
    {
        var source = @"
import System.Collections.Generic

var d = Dictionary[string, int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StringBuilder_WithCapacityArgument_Binds()
    {
        var source = @"
import System.Text

var sb = StringBuilder(16)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StringBuilder_TooManyArguments_Diagnoses()
    {
        var source = @"
import System.Text

var sb = StringBuilder(""x"", ""y"", ""z"")
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}

public sealed class Issue3466ImportedService
{
    public Issue3466ImportedService()
    {
        this.Value = 7;
    }

    public int Value { get; }
}
