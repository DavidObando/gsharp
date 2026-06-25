// <copyright file="Issue1103ExtensionInstanceCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1103. A receiver-clause extension (ADR-0019) on an imported/BCL or
/// primitive CLR type must bind with instance/member syntax
/// (<c>receiver.Ext()</c>) and not only as a free function
/// (<c>Ext(receiver)</c>).
/// <para>
/// Two defects produced <c>GS0159 Cannot find function</c> on the member-syntax
/// form: (1) the body-binding pass rebuilt its lookup scope from the previous
/// global scope without re-registering the flattened extension functions as
/// extensions, so <see cref="BoundScope.TryLookupExtensionFunction"/> found
/// nothing inside any function/method body; and (2) the receiver match compared
/// the declared and call-site receiver type symbols by reference, which fails
/// for imported CLR types whose symbols are distinct instances wrapping the same
/// CLR type. The match is now structural (CLR-type identity) with reference
/// equality kept as the fast path for interned user types.
/// </para>
/// </summary>
public class Issue1103ExtensionInstanceCallTests
{
    [Fact]
    public void PrimitiveExtension_InstanceSyntax_InsideFunctionBody_Binds()
    {
        const string source = @"
package P

func (n int32) Doubled() int32 {
    return n * 2
}

func run(x int32) int32 {
    return x.Doubled()
}

run(21)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void PrimitiveExtension_InstanceSyntax_InsideClassMethod_Binds()
    {
        const string source = @"
package P

func (n int32) Doubled() int32 {
    return n * 2
}

class Calc {
    func Run(x int32) int32 {
        return x.Doubled()
    }
}

var c = Calc()
c.Run(21)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void PrimitiveExtension_InstanceSyntax_AtTopLevel_Binds()
    {
        const string source = @"
package P

func (n int32) Doubled() int32 {
    return n * 2
}

var x int32 = 21
x.Doubled()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Extension_FreeCallForm_InsideFunctionBody_Control_StillBinds()
    {
        // Control: the free-call form always bound; it must keep working.
        const string source = @"
package P

func (n int32) Doubled() int32 {
    return n * 2
}

func run(x int32) int32 {
    return Doubled(x)
}

run(21)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void PrimitiveExtension_InstanceSyntax_InsideFunctionBody_NoGS0159()
    {
        const string source = @"
package P

func (n int32) Doubled() int32 {
    return n * 2
}

func run(x int32) int32 {
    return x.Doubled()
}

run(5)
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Message.Contains("Cannot find function"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
