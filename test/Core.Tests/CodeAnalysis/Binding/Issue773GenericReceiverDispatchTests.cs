// <copyright file="Issue773GenericReceiverDispatchTests.cs" company="GSharp">
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
/// Issue #773 / ADR-0084 §L2 follow-up. The binder must dispatch a
/// call site like <c>recv.M()</c> to a user-declared extension whose
/// receiver type contains a function-level type parameter — e.g.
/// <c>func (self sequence[T]) FirstOrNil[T]() T?</c> or
/// <c>func (self IEnumerable[T]) MyFirst[T any](fb T) T</c>.
///
/// Prior to the fix, <see cref="BoundScope.TryLookupExtensionFunction"/>
/// matched extensions by reference-equality on the receiver type, so an
/// extension declared with an open generic receiver (whose receiver
/// type carries an open type parameter) was unreachable from any call
/// site — the lookup reported GS0159 "Cannot find function".
/// </summary>
public class Issue773GenericReceiverDispatchTests
{
    [Fact]
    public void Repro_FromIssue_IEnumerableT_Extension_Dispatches_On_Int32Slice()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) MyFirst[T any](fb T) T {
    return fb
}

var arr = []int32{10, 20, 30}
arr.MyFirst(99)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void SequenceT_Extension_Dispatches_On_Int32Slice()
    {
        const string source = @"
package P
import System

func (self sequence[T]) HeadOr[T](fb T) T {
    return fb
}

var arr = []int32{1, 2, 3}
arr.HeadOr(7)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void SequenceT_Extension_Dispatches_On_StringSlice()
    {
        const string source = @"
package P
import System

func (self sequence[T]) HeadOr[T](fb T) T {
    return fb
}

var arr = []string{""a"", ""b""}
arr.HeadOr(""z"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("z", result.Value);
    }

    [Fact]
    public void SequenceT_Extension_Dispatches_On_DictionaryKeys()
    {
        // `Dictionary[K, V].Keys` returns `KeyCollection` which implements
        // `IEnumerable<K>`. The extension `(self sequence[T])` must unify
        // T against the KeyCollection's element type by walking the CLR
        // interface set.
        const string source = @"
package P
import System
import System.Collections.Generic

func (self sequence[T]) HeadOr[T](fb T) T {
    return fb
}

var d = Dictionary[string, int32]()
d[""a""] = 1
d.Keys.HeadOr(""z"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("z", result.Value);
    }

    [Fact]
    public void NullableReceiver_Extension_Dispatches_On_StringNullable()
    {
        const string source = @"
package P
import System

func (self T?) MyOrElse[T](fb T) T {
    if self != nil { return self!! }
    return fb
}

var s string? = nil
s.MyOrElse(""def"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("def", result.Value);
    }

    [Fact]
    public void NullableReceiver_Extension_Dispatches_On_Int32Nullable()
    {
        const string source = @"
package P
import System

func (self T?) MyOrElse[T](fb T) T {
    if self != nil { return self!! }
    return fb
}

var v int32? = nil
v.MyOrElse(99)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void NullableReceiver_Extension_Dispatches_On_UserNullableStruct()
    {
        const string source = @"
package P
import System

struct Point {
    var X int32
    var Y int32
}

func (self T?) MyOrElse[T](fb T) T {
    if self != nil { return self!! }
    return fb
}

var pt Point? = nil
var def = Point{X: 1, Y: 2}
var r = pt.MyOrElse(def)
r.X
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void MultiTypeParameters_DictionaryReceiver_Dispatches()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

func (self Dictionary[K, V]) MyCount[K, V]() int32 {
    return 42
}

var d = Dictionary[string, int32]()
d.MyCount()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConstraintViolation_DoesNotDispatch()
    {
        // Issue #773 + ADR-0088: the generic-receiver path runs receiver
        // inference first, and then the call-site overload pipeline in
        // BindExtensionFunctionCall enforces the per-type-parameter
        // constraints. Calling `Foo` with a receiver that does not
        // satisfy the constraint must fail with the standard constraint
        // diagnostic.
        const string source = @"
package P
import System

sealed interface ITagged {
    func Tag() string
}

func (self T) Branded[T ITagged]() string {
    return self.Tag()
}

var v = 1
v.Branded()
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Constraint_Satisfied_Dispatches()
    {
        const string source = @"
package P
import System

sealed interface ITagged {
    func Tag() string
}

class Card : ITagged {
    func Tag() string {
        return ""card""
    }
}

func (self T) Branded[T ITagged]() string {
    return self.Tag()
}

var c = Card()
c.Branded()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("card", result.Value);
    }

    [Fact]
    public void ClosedReceiver_StillWorks_AfterFix_OnNonGenericString()
    {
        // Regression guard: the fast-path exact-match for closed receivers
        // must still resolve. This was the working path pre-fix.
        const string source = @"
package P
import System

func (s string) Loud() string {
    return s + ""!""
}

var greeting = ""hi""
greeting.Loud()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi!", result.Value);
    }

    [Fact]
    public void ClosedReceiver_TakesPrecedenceOverGenericReceiver()
    {
        // Both extensions match the call site. The closed-receiver
        // declaration is preferred (it is the fast-path match) so the
        // returned string is "closed".
        const string source = @"
package P
import System

func (self []int32) Tag() string {
    return ""closed""
}

func (self []T) Tag[T]() string {
    return ""generic""
}

var arr = []int32{1, 2}
arr.Tag()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("closed", result.Value);
    }

    [Fact]
    public void GenericReceiver_OverSlice_OfT()
    {
        const string source = @"
package P
import System

func (self []T) MyCount[T]() int32 {
    return 7
}

var a = []int32{1, 2, 3}
a.MyCount()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void GenericReceiver_TypeArgument_FlowsToBody()
    {
        // The substituted T must be observable through the body — a
        // parameter typed `T` must accept the inferred element type.
        const string source = @"
package P
import System

func (self []T) FirstOr[T](fb T) T {
    return fb
}

var a = []int32{1, 2, 3}
a.FirstOr(99)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
