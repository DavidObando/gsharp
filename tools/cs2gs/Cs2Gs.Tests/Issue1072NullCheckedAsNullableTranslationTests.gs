// <copyright file="Issue1072NullCheckedAsNullableTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #1072: G# follows Kotlin-style nullability
/// safety, so a `nil` comparison or `nil` assignment is only legal on a nullable
/// type. A C# parameter/field/local DECLARED non-nullable (`T`) but defensively
/// compared against `null` (`== null` / `!= null`) or assigned
/// `null` / `null!` is in truth nullable, so the faithful G# rendering of
/// its type clause is the nullable `T?` (otherwise gsc rejects the guard with
/// `GS0129`). The negative tests pin the precision guard so a parameter/field
/// that is never null-checked nor null-assigned keeps its non-nullable type.
open class Issue1072NullCheckedAsNullableTranslationTests {
    @Fact
    func NullCheckedReferenceParameter_RendersNullableType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void F(string s)
        {
            if (s == null) throw new System.ArgumentException("s");
            System.Console.WriteLine(s.Length);
        }
    }
}`)
        Assert.Contains("F(s string?)", printed)
    }

    @Fact
    func NullCheckedArrayParameter_RendersNullableType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public C(byte[] key)
        {
            if (key == null || key.Length != 16) throw new System.ArgumentException("key");
        }
    }
}`)
        Assert.Contains("key []?uint8", printed)
    }

    @Fact
    func IsNullPatternCheckedArrayParameter_RendersNullableType() {
        // `key is null` (constant pattern) is the C# pattern form of a null
        // comparison; it must promote the parameter to nullable just like `==`.
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public C(byte[] iv)
        {
            if (iv is null || iv.Length != 16) throw new System.ArgumentException("iv");
        }
    }
}`)
        Assert.Contains("iv []?uint8", printed)
    }

    @Fact
    func NullAssignedReferenceField_RendersNullableType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private string name = null!;
        public void Reset() { name = null!; }
    }
}`)
        Assert.Contains("name string?", printed)
    }

    @Fact
    func NullComparedReferenceField_RendersNullableType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private object box = new object();
        public bool HasBox() => box != null;
    }
}`)
        Assert.Contains("box object?", printed)
    }

    @Fact
    func NeverNullCheckedReferenceParameter_StaysNonNullable() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int F(string s)
        {
            return s.Length;
        }
    }
}`)
        Assert.Contains("F(s string)", printed)
    }

    @Fact
    func FlowNarrowedNullableValue_UsesGSharpSmartCastsAtNonNullSinks() {
        let printed = TranslateUnit(`
#nullable enable
using System;

namespace Demo
{
    public class C
    {
        private static void Use(Type value) { }

        public static void M(Type? next)
        {
            if (next == null) return;

            Use(next);
            Type current = typeof(string);
            current = next;
            Type[] values = new Type[1];
            values[0] = next;
        }
    }
}`)
        Assert.Contains("Use(next)", printed)
        Assert.Contains("current = next", printed)
        Assert.Contains("values[0] = next!!", printed)
        Assert.DoesNotContain("Use(next!!)", printed)
        Assert.DoesNotContain("current = next!!", printed)
    }

    @Fact
    func NotNullIfNotNullResult_IsAssertedAtNonNullSink() {
        let printed = TranslateUnit(`
#nullable enable
using System.Diagnostics.CodeAnalysis;

namespace Demo
{
    public class C
    {
        [return: NotNullIfNotNull("value")]
        private static string? Echo(string? value) => value;

        public static string M(string? value)
        {
            if (value == null) return "";
            return Echo(value);
        }
    }
}`)
        Assert.Contains("return Echo(value)!!", printed)
        Assert.DoesNotContain("s string?", printed)
    }

    @Fact
    func NeverNullCheckedReferenceField_StaysNonNullable() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private string name = "x";
        public int Len() => name.Length;
    }
}`)
        Assert.Contains("name string", printed)
        Assert.DoesNotContain("name string?", printed)
    }

    @Fact
    func NullCheckedValueParameter_StaysNonNullable() {
        // Value types are out of scope for this pass: an `int` compared to null is
        // a C# nullable-value scenario handled elsewhere, not a reference promotion.
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public void F(int x)
        {
            System.Console.WriteLine(x);
        }
    }
}`)
        Assert.Contains("F(x int32)", printed)
        Assert.DoesNotContain("x int32?", printed)
    }

    @Fact
    func NullableTypeParameterReturn_RendersNullableType() {
        // A `T?` return on a method whose type parameter is interface-constrained
        // (`where T : IBox`) reports `IsReferenceType == false` in Roslyn, so the
        // `?` must be honoured via the type-parameter path or it is silently
        // dropped and `let x = GetChild<T>()` infers a non-nullable `T`, breaking
        // the subsequent `x == nil` guard at the call site (issue #1072 cascade).
        let printed = TranslateUnit(`
namespace Demo
{
    public interface IBox { }
    public class Box : IBox
    {
        public T? GetChild<T>() where T : IBox => default;
    }
}`)
        Assert.Contains("GetChild[T IBox]() T?", printed)
    }

    @Fact
    func NullComparedInferredLocal_RendersNullableType() {
        // A `var x = e` local with no explicit type whose initializer is a
        // non-nullable reference but which is compared to `null` is really
        // nullable: inference over the non-null initializer would pick the
        // non-nullable type and the `!= nil` guard would fail with GS0129, so an
        // explicit `T?` annotation must be emitted (issue #1072 inferred-local form).
        let printed = TranslateUnit(`
namespace Demo
{
    public class Box { public string Name = string.Empty; }
    public class C
    {
        private static Box Find() => new Box();
        public string Run()
        {
            var found = Find();
            if (found != null) { return found.Name; }
            return string.Empty;
        }
    }
}`)
        Assert.Contains("found Box? =", printed)
        Assert.DoesNotContain("let found =", printed)
    }

    @Fact
    func CrossFilePromotedPropertyReceiver_GetsNonNullAssertion() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Scope.cs", `
namespace Demo
{
    public class Resolver { public void Run() { } }
    public class Scope
    {
        public Resolver References { get; } = new Resolver();
        public bool Missing() => References == null;
    }
}`), ("Use.cs", `
namespace Demo
{
    public class Use
    {
        private Scope scope = new Scope();
        public void Run() => scope.References.Run();
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let translator = CSharpToGSharpTranslator()
        let printed = project
            .Documents
            .Select(
            (document LoadedDocument) -> {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                return GSharpPrinter.Print(translator.TranslateDocument(document, context))
            }
        )
            .ToArray()
        Assert.Contains("References Resolver?", printed[0], StringComparison.Ordinal)
        Assert.Contains("$$scope.References!!.Run()", printed[1], StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func FlowNarrowedProperty_InArrayInitializer_GetsNonNullAssertion() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Box { public string? Value { get; set; } }
    public class C
    {
        public string[] Read(Box box)
        {
            if (box.Value is null) return System.Array.Empty<string>();
            return new[] { box.Value };
        }
    }
}`)
        Assert.Contains("[]string{box.Value!!}", printed, StringComparison.Ordinal)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
