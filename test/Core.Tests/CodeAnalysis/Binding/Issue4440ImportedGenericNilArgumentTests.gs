// <copyright file="Issue4440ImportedGenericNilArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #4440: an imported generic member parameter must retain the
/// nullability of the receiver type argument when the argument is converted.
/// @remarks <b>Discrimination (ADR-0154).</b> On parent commit
/// `dbba5cdb01cbe65e1a9d116a811e209e7934ba56`, every rejection row
/// compiles without GS0155. Removing the receiver-aware parameter read
/// restores that failure, while all controls remain green.
class Issue4440ImportedGenericNilArgumentTests {
    @Theory
    @MemberData("RejectedCases")
    func NilAtNonNullSubstitutedParameterReportsGs0155(source string, line int32) {
        let diagnostic = Assert.Single(Errors(Compile(source)))
        Assert.Equal("GS0155", diagnostic.Id)
        Assert.Equal(line, diagnostic.Location.StartLine + 1)
        Assert.Contains("nil", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func NonNullNullableAndValueArgumentsCompile() {
        const source = `import System.Collections.Generic

let strings = List[string]{"a"}
strings.Add("b")

let nullableStrings = List[string?]{nil}
nullableStrings.Add(nil)

let values = List[int32]{1}
values.Add(2)`
        Assert.Empty(Errors(Compile(source)))
    }

    @Fact
    func ValueTypeInstantiationStillRejectsNil() {
        let errors = Errors(Compile(`import System.Collections.Generic
let values = List[int32]()
values.Add(nil)`))
        Assert.NotEmpty(errors)
    }

    @Fact
    func NullableAndObliviousTargetsStillAcceptNil() {
        const librarySource = `#nullable disable
namespace Issue4440.Library;

using System.Collections.Generic;

public static class Ob
{
    public static List<string> Strings() => new();
}

public sealed class LegacySink
{
    public void Take(string value) { }
}

#nullable enable
public sealed class Box<T>
{
    public U Echo<U>(U value) => value;
    public void SetMaybe(T? value) { }
}

public interface IBox<T>
{
    void Put(T value);
}

public sealed class Sink
{
    public void Take(string value) { }
}`
        using let library = CSharpFixture(librarySource)
        using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
        let diagnostics = Compile(`import Issue4440.Library
let box = Box[int32]()
let text string = box.Echo[string]("ok")
let maybe string? = box.Echo[string?](nil)
let nullable string? = nil
Sink().Take(nullable)
Ob.Strings().Add(nil)
LegacySink().Take(nil)
Box[string]().SetMaybe(nil)`, resolver)
        Assert.Empty(Errors(diagnostics))
    }

    @Fact
    func ConstrainedImportedGenericParameterAlsoRejectsNil() {
        const librarySource = `#nullable enable
namespace Issue4440.Library;

public interface IBox<T>
{
    void Put(T value);
}

public sealed class Box<T>
{
    public void Put<U>(T value, U marker) { }
}`
        using let library = CSharpFixture(librarySource)
        using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
        let diagnostics = Errors(Compile(`import Issue4440.Library
func PutNil[B IBox[string]](box B) {
    box.Put(nil)
}

Box[string]().Put[int32](nil, 0)`, resolver))
        Assert.Equal([]string{"GS0155", "GS0155"}, diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id))
        Assert.Equal(
            []int32{3, 6},
            diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Location.StartLine + 1).Order()
        )
    }

    @Fact
    func ImportedExtensionProjectsUserArgumentAfterReceiver() {
        const librarySource = `#nullable enable
namespace Issue4440.Library;

using System;
using System.Collections.Generic;

public static class Extensions
{
    public static void Put<T>(this List<T> values, T value) { }
    public static void PutMade<T, U>(
        this List<T> values,
        U value,
        Func<U> factory) { }
}`
        using let library = CSharpFixture(librarySource)
        using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
        let diagnostics = Errors(Compile(`import System.Collections.Generic
import Issue4440.Library
func Text() string -> "x"
List[string]().Put(nil)
List[int32]().PutMade(nil, Text)`, resolver))
        Assert.Equal([]string{"GS0155", "GS0155"}, diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id))
        Assert.Equal(
            []int32{4, 5},
            diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Location.StartLine + 1).Order()
        )
    }

    @Fact
    func ImportedExtensionPreservesExplicitNullableMethodTypeArgument() {
        const librarySource = `#nullable enable
namespace Issue4440.Library;

public static class Extensions
{
    public static void Put<T>(this T? receiver, T value) { }
}`
        using let library = CSharpFixture(librarySource)
        using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
        Assert.Empty(Errors(Compile("import Issue4440.Library\n\"x\".Put[string?](nil)", resolver)))
    }

    @Fact
    func ImportedExtensionExplicitNonNullMethodTypeArgumentStillRejectsNil() {
        const librarySource = `#nullable enable
namespace Issue4440.Library;

public static class Extensions
{
    public static void Put<T>(this T? receiver, T value) { }
}`
        using let library = CSharpFixture(librarySource)
        using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
        let diagnostic = Assert.Single(Errors(Compile("import Issue4440.Library\n\"x\".Put[string](nil)", resolver)))
        Assert.Equal("GS0155", diagnostic.Id)
        Assert.Equal(2, diagnostic.Location.StartLine + 1)
    }

    @Fact
    func ImportedStaticCallsProjectGenericArguments() {
        const librarySource = `#nullable enable
namespace Issue4440.Library;

using System.Collections.Generic;

public static class StaticSink
{
    public static void Put<T>(T value) { }
}

public sealed class StaticBox<T>
{
    public static void Put(T value) { }
}

public class StaticOuter<T>
{
    public sealed class Nested
    {
        public static void Put(T value) { }
    }

    public sealed class Middle
    {
        public sealed class Inner
        {
            public static void Put(T value) { }
        }
    }
}

public static class Extensions
{
    public static void Put<T>(this List<T> values, T value) { }
}`
        using let library = CSharpFixture(librarySource)
        using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
        let diagnostics = Errors(Compile(`import System.Collections.Generic
import Issue4440.Library
class NullableDerived : StaticOuter[string?] { }
StaticSink.Put[string](nil)
StaticBox[string].Put(nil)
StaticOuter[string].Nested.Put(nil)
StaticOuter[string].Middle.Inner.Put(nil)
NullableDerived.Nested.Put(nil)
Extensions.Put[string](List[string](), nil)`, resolver))
        Assert.Equal(
            []string{"GS0155", "GS0155", "GS0155", "GS0155", "GS0155"},
            diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id)
        )
        Assert.Equal(
            []int32{4, 5, 6, 7, 9},
            diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Location.StartLine + 1).Order()
        )
    }

    @Fact
    func ImportedInParametersProjectGenericNilTargets() {
        const librarySource = `#nullable enable
namespace Issue4440.Library;

public sealed class InBox<T>
{
    public void Take(in T value) { }
    public void TakeMethod<U>(in U value) { }
}

public static class InSink
{
    public static void Take<T>(in T value) { }
}`
        using let library = CSharpFixture(librarySource)
        using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
        let diagnostics = Errors(Compile(`import Issue4440.Library
InBox[string]().Take(nil)
InBox[string]().TakeMethod[string](nil)
InSink.Take[string](nil)
InBox[string]().TakeMethod[string?](nil)
InSink.Take[string?](nil)`, resolver))
        Assert.Equal(
            []int32{2, 3, 4},
            diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Location.StartLine + 1).Order()
        )
        Assert.Equal(
            []string{"GS0155", "GS0155", "GS0155"},
            diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id)
        )
    }

    shared {
        prop RejectedCases TheoryData[string, int32] -> TheoryData[string, int32]{`import System.Collections.Generic
let xs = List[string]()
xs.Add(nil)`: 3, "import System.Collections.Generic\nlet xs = List[string]{\"a\", nil}": 2, `import System.Collections.Generic
let xs = List[List[string]]()
xs.Add(nil)`: 3}

        private func Compile(source string) ImmutableArray[Diagnostic] {
            using let resolver = ReferenceResolver.Default()
            return Compile(source, resolver)
        }

        private func Compile(source string, resolver ReferenceResolver) ImmutableArray[Diagnostic] {
            let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source))){
                Nullability = NullabilityMode.PlatformTypes
            }
            return compilation.GlobalScope.Diagnostics.AddRange(compilation.BoundProgram.Diagnostics)
        }

        private func Errors(diagnostics ImmutableArray[Diagnostic]) ImmutableArray[Diagnostic] -> diagnostics.Where(
            (diagnostic Diagnostic) -> diagnostic.IsError
        )
            .ToImmutableArray()
    }
}
