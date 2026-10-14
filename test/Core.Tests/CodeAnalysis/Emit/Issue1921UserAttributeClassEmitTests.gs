// <copyright file="Issue1921UserAttributeClassEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #1921: a hand-written G# class explicitly deriving from
/// `System.Attribute` — `class NoteAttribute : Attribute { … }`, with
/// no `@Attribute` declaration sugar — used to be rejected with GS0200
/// ("Type 'NoteAttribute' is not an attribute class") even though it plainly
/// derives from `System.Attribute`. The root cause was
/// `DeclarationBinder.IsAttributeType` checking only the
/// `StructSymbol.IsAttributeClass` flag (set exclusively by the
/// `@Attribute` sugar path) or the type's own (still-null,
/// pre-emission) `ClrType`, never walking the symbol-level
/// `BaseClass`/`ImportedBaseType` chain a same-compilation class
/// actually has. Once GS0200 recognition was fixed
/// ((cref:StructSymbol.DerivesFromSystemAttribute)), a second gap
/// surfaced: `CustomAttributeEncoder.EmitBoundAttribute` also keyed off
/// `ClrType` and silently dropped the attribute application from the
/// emitted metadata entirely. Both are exercised here end to end: the type
/// declares, the annotation applies, and the applied attribute — including
/// its constructor argument — round-trips through real
/// (cref:System.Type.GetCustomAttributes(bool)) reflection on the
/// compiled assembly.
open class Issue1921UserAttributeClassEmitTests {
    @Fact
    func PlainColonAttributeBase_WithPrimaryCtorArg_AppliesAndRoundTripsThroughReflection() {
        const Source = `package Issue1921Plain
import System

class NoteAttribute(Text string) : Attribute {
}

@Note("hello-world")
class Widget {
}

func run() {
    var t Type = typeof(Widget)
    var attrs = t.GetCustomAttributes(true)
    for var i int32 = 0; i < attrs.Length; i += 1 {
        if attrs[i].GetType().Name == "NoteAttribute" {
            var a NoteAttribute = (attrs[i] as NoteAttribute)!!
            Console.WriteLine("Note:" + a.Text)
        }
    }
}

run()
`
        let output = CompileAndRun(
            Source,
            "PlainColonAttributeBase_WithPrimaryCtorArg_AppliesAndRoundTripsThroughReflection"
        )
        Assert.Contains("Note:hello-world", output)
    }

    @Fact
    func FullyQualifiedSystemAttributeBase_ParameterlessMarker_AppliesAndRoundTrips() {
        const Source = `package Issue1921Qualified
import System

class MarkerAttribute : System.Attribute {
}

@Marker
class Widget {
}

func run() {
    var t Type = typeof(Widget)
    var attrs = t.GetCustomAttributes(true)
    var found bool = false
    for var i int32 = 0; i < attrs.Length; i += 1 {
        if attrs[i].GetType().Name == "MarkerAttribute" {
            found = true
        }
    }
    Console.WriteLine("found=" + found.ToString())
}

run()
`
        let output = CompileAndRun(Source, "FullyQualifiedSystemAttributeBase_ParameterlessMarker_AppliesAndRoundTrips")
        Assert.Contains("found=True", output)
    }

    @Fact
    func AttributeSugarClass_StillDerivesFromSystemAttribute_AndApplies() {
        // ADR-0047 §5's `@Attribute` sugar predates this issue and must keep
        // working unchanged alongside the newly recognized plain `: Attribute`
        // spelling fixed here.
        const Source = `package Issue1921Sugar
import System

@Attribute
class SugarAttribute {
}

@Sugar
class Widget {
}

func run() {
    var t Type = typeof(Widget)
    var attrs = t.GetCustomAttributes(true)
    var found bool = false
    for var i int32 = 0; i < attrs.Length; i += 1 {
        if attrs[i].GetType().Name == "SugarAttribute" {
            found = true
        }
    }
    Console.WriteLine("found=" + found.ToString())
}

run()
`
        let output = CompileAndRun(Source, "AttributeSugarClass_StillDerivesFromSystemAttribute_AndApplies")
        Assert.Contains("found=True", output)
    }

    @Fact
    func OverloadedExplicitCtors_SameArity_SelectsMatchingParameterType() {
        // Code-review follow-up: two `init(...)` overloads with the same
        // arity but different parameter types used to be disambiguated by
        // declaration order alone (whichever came first in
        // EffectiveExplicitConstructors), regardless of the actual argument
        // type. `@Tag(42)` must select the int32 overload, not string.
        const Source = `package Issue1921Overload
import System

class TagAttribute : Attribute {
    var Which int32 = 0
    init(x string) {
        Which = 1
    }
    init(x int32) {
        Which = 2
    }
}

@Tag(42)
class Widget {
}

func run() {
    var t Type = typeof(Widget)
    var attrs = t.GetCustomAttributes(true)
    for var i int32 = 0; i < attrs.Length; i += 1 {
        if attrs[i].GetType().Name == "TagAttribute" {
            var a TagAttribute = (attrs[i] as TagAttribute)!!
            Console.WriteLine("Which:" + a.Which.ToString())
        }
    }
}

run()
`
        let output = CompileAndRun(Source, "OverloadedExplicitCtors_SameArity_SelectsMatchingParameterType")
        Assert.Contains("Which:2", output)
    }

    @Fact
    func OverloadedExplicitCtors_AmbiguousArgument_ReportsGS9998() {
        // A `string` overload and an `Object` overload both accept a string
        // argument (everything is assignable to Object) — genuinely
        // ambiguous, no argument-type information can disambiguate. Must be
        // rejected with a diagnostic rather than silently picking whichever
        // came first in declaration order.
        const Source = `package Issue1921Ambiguous
import System

class TagAttribute : Attribute {
    init(x string) {
    }
    init(x Object) {
    }
}

@Tag("hello")
class Widget {
}
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    shared {
        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
