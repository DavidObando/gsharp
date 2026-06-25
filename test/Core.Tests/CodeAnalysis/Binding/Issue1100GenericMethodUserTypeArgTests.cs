// <copyright file="Issue1100GenericMethodUserTypeArgTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1100 (binding facet): a generic method invoked on a constructed BCL
/// generic receiver whose type argument is a same-compilation user type must
/// recover the symbolic substituted result type instead of erasing it to
/// <c>object</c>. For <c>Queue[Entry]</c> (with <c>Entry</c> declared in the
/// same compilation), <c>q.Dequeue()</c> must bind to <c>Entry</c> so that an
/// <c>Entry</c>-typed target assigns without <c>GS0155</c>, and
/// <c>q.Enqueue(e)</c> must accept an <c>Entry</c> argument.
/// </summary>
public class Issue1100GenericMethodUserTypeArgTests
{
    [Fact]
    public void Dequeue_OnQueueOfUserType_BindsToUserType_NotObject()
    {
        // Before the fix the generic method return type T erased to `object`,
        // so assigning `q.Dequeue()` to an `Entry`-typed local reported GS0155
        // ("Cannot convert type 'object' to 'Entry'").
        var source = @"
import System.Collections.Generic

class Entry { }

class C {
    let q Queue[Entry] = Queue[Entry]()

    func drain() {
        let x Entry = q.Dequeue()
    }
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Message.Contains("GS0155"));
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Enqueue_OnQueueOfUserType_AcceptsUserTypeArgument()
    {
        // The by-T parameter of Enqueue must accept an `Entry` argument rather
        // than erasing to `object` and rejecting the call.
        var source = @"
import System.Collections.Generic

class Entry { }

class C {
    let q Queue[Entry] = Queue[Entry]()

    func add(e Entry) {
        q.Enqueue(e)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void EnqueueDequeueCount_RoundTrip_OnQueueOfUserType_Binds()
    {
        // Full round trip exercising Enqueue (by-T parameter), Count, and
        // Dequeue (T return) on a same-compilation user type argument.
        var source = @"
import System.Collections.Generic

class Entry {
    var Value int32
}

class C {
    let q Queue[Entry] = Queue[Entry]()

    func add(e Entry) {
        q.Enqueue(e)
    }

    func drainSum() int32 {
        var total = 0
        while q.Count > 0 {
            let x = q.Dequeue()
            total = total + x.Value
        }
        return total
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
