// <copyright file="Issue1920GenericPrimaryCtorFromClassMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #1920: a GENERIC class (or <c>data struct</c>) with a primary
/// constructor ICEd at every instantiation with GS9998
/// (<c>InvalidOperationException: Type '...' has no emitted primary ctor.</c>)
/// whenever the construction happened from inside another type's method (a
/// <c>shared</c>/static method or an instance method) rather than a top-level
/// <c>func</c>. Root cause:
/// <see cref="GSharp.Core.CodeAnalysis.Emit.ReflectionMetadataEmitter.ResolveUserCtorTokenForPrimary"/>
/// looked up <c>ClassPrimaryCtorHandles</c> keyed by the CONSTRUCTED
/// <c>StructSymbol</c> instead of falling back to its open
/// <c>Definition</c> — the alias that mirrors the definition's handle onto a
/// specific constructed instantiation
/// (<c>MethodBodyPlanner.RegisterConstructedTypeAliases</c>) is only
/// populated for constructions reachable from top-level function/lambda
/// bodies, so any construction from within a class method never gets an
/// alias entry and the lookup failed. These end-to-end emit+run tests prove
/// the primary ctor executes at runtime for constrained, unconstrained,
/// struct-kind, and multi-type-parameter generic types, all invoked from a
/// class's <c>shared</c> method (the exact shape that reproduced the ICE).
/// </summary>
public class Issue1920GenericPrimaryCtorFromClassMethodEmitTests
{
    [Fact]
    public void ClassConstrainedTypeParameter_ConstructsFromSharedMethod_ReadsField()
    {
        const string Source = @"package P
class RefKeeper[T class](_kept T, _tag int32) {
    func Kept() T { return _kept }
    func Tag() int32 { return _tag }
}
class Fixture {
    shared {
        func Run() int32 {
            let keeper = RefKeeper[string](""pinned"", 7)
            return keeper.Tag()
        }
    }
}
func main() int32 {
    return Fixture.Run()
}
";
        Assert.Equal(7, RunMain(Source));
    }

    [Fact]
    public void StructConstrainedTypeParameter_ConstructsFromSharedMethod_ReadsField()
    {
        const string Source = @"package P
class ValueCell[T struct](_value T, _tag int32) {
    func Value() T { return _value }
    func Tag() int32 { return _tag }
}
class Fixture {
    shared {
        func Run() int32 {
            let cell = ValueCell[int32](64, 9)
            return cell.Value() + cell.Tag()
        }
    }
}
func main() int32 {
    return Fixture.Run()
}
";
        Assert.Equal(73, RunMain(Source));
    }

    [Fact]
    public void UnconstrainedTypeParameter_ConstructsFromSharedMethod_ReadsField()
    {
        const string Source = @"package P
class Box[T](_item T) {
    func Item() T { return _item }
}
class Fixture {
    shared {
        func Run() int32 {
            let box = Box[int32](21)
            return box.Item()
        }
    }
}
func main() int32 {
    return Fixture.Run()
}
";
        Assert.Equal(21, RunMain(Source));
    }

    [Fact]
    public void MultiTypeParameter_ConstructsFromSharedMethod_ReadsBothFields()
    {
        const string Source = @"package P
class Pair[A, B](_first A, _second B) {
    func First() A { return _first }
    func Second() B { return _second }
}
class Fixture {
    shared {
        func Run() int32 {
            let pair = Pair[int32, string](5, ""five"")
            if (pair.Second() == ""five"") {
                return pair.First()
            }
            return -1
        }
    }
}
func main() int32 {
    return Fixture.Run()
}
";
        Assert.Equal(5, RunMain(Source));
    }

    [Fact]
    public void DataStructGeneric_ConstructsFromSharedMethod_ReadsField()
    {
        const string Source = @"package P
data struct Wrapper[T](Value T) { }
class Fixture {
    shared {
        func Run() int32 {
            let w = Wrapper[int32](99)
            return w.Value
        }
    }
}
func main() int32 {
    return Fixture.Run()
}
";
        Assert.Equal(99, RunMain(Source));
    }

    private static object RunMain(string source)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(Issue1920GenericPrimaryCtorFromClassMethodEmitTests), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var method = programType!.GetMethod("main", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(method);
            return method!.Invoke(null, null);
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
