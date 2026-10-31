// <copyright file="Issue3682NullElementTargetTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3682: a C# array / slice literal that literally writes `null`
/// into a non-nullable reference element type. The C# is legal — the literal
/// lives in an oblivious file, so nothing is reported — but G#'s element type
/// really is non-nullable and gsc rejects the emitted `nil` (GS0155,
/// `Cannot convert type 'nil' to 'object'`). The literal's element type is
/// inferred AT the literal rather than pinned by a declaration, so the faithful
/// repair is to widen it to `T?`; a `!!` bridge would turn a clean C#
/// `new object[] { a, null }` into a runtime throw.
open class Issue3682NullElementTargetTypeTests {
    @Fact
    func ExplicitObjectArrayWithNullElements_RendersNullableElementType() {
        let printed = TranslateUnit(`
using System.Reflection;

namespace Demo
{
    public class C
    {
        public object F(ConstructorInfo ctor, object program)
        {
            return ctor.Invoke(new object[] { program, null, false, null });
        }
    }
}`)
        Assert.Contains("[]object?{program, nil, false, nil}", printed)
    }

    @Fact
    func ObjectArrayLocalWithNullElement_RendersNullableElementType() {
        let printed = TranslateUnit(`
using System;
using System.Reflection;

namespace Demo
{
    public class C
    {
        public object F(MethodInfo method, object cache, Type type)
        {
            var args = new object[] { type, null };
            return method.Invoke(cache, args);
        }
    }
}`)
        Assert.Contains("[]object?{type, nil}", printed)
    }

    @Fact
    func BareObjectArrayInitializerWithNullElement_RendersNullableElementType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public object[] F()
        {
            object[] arguments = { null };
            return arguments;
        }
    }
}`)
        Assert.Contains("[]object?{nil}", printed)
    }

    @Fact
    func ImplicitlyTypedArrayWithNullElements_RendersNullableElementType() {
        let printed = TranslateUnit(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public void Check<T>(IEnumerable<T> items)
        {
        }

        public void F()
        {
            this.Check(new[] { null, null, "d" });
        }
    }
}`)
        Assert.Contains("[]string?{nil, nil, \"d\"}", printed)
    }

    @Fact
    func CollectionExpressionWithNullElements_RendersNullableElementType() {
        let printed = TranslateUnit(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public void Check<T>(IEnumerable<T> items)
        {
        }

        public void F()
        {
            this.Check<string>([null, null, "d"]);
        }
    }
}`)
        Assert.Contains("[]string?{nil, nil, \"d\"}", printed)
    }

    @Fact
    func CollectionInitializerTarget_NullLiteralDoesNotGainRuntimeAssertion() {
        let printed = TranslateUnit(`
#nullable enable
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public List<string> F(string value)
        {
            return [null, value];
        }
    }
}`)
        Assert.Contains("default(string)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("nil!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func GenericCallTarget_NullLiteralUsesTypedDefault() {
        let printed = TranslateUnit(`
#nullable enable
using System.Threading.Tasks;

namespace Demo
{
    public class C
    {
        public void F(TaskCompletionSource<string>? challengeTcs)
        {
            challengeTcs?.TrySetResult(null);
        }
    }
}`)
        Assert.Contains("challengeTcs?.TrySetResult(default(string))", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("nil!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func GenericNullableCallTarget_NullLiteralRemainsNil() {
        let printed = TranslateUnit(`
#nullable enable
using System.Threading.Tasks;

namespace Demo
{
    public class C
    {
        public void F(TaskCompletionSource<string?> challengeTcs)
        {
            challengeTcs.TrySetResult(null);
        }
    }
}`)
        Assert.Contains("challengeTcs.TrySetResult(nil)", printed, StringComparison.Ordinal)
    }

    @Fact
    func NestedGenericCallTargets_NullLiteralUsesTypedDefault() {
        let printed = TranslateUnit(`
#nullable enable
using System.Collections.Generic;

namespace Demo
{
    public static class C
    {
        public class Outer<T>
        {
            public class Inner { }
        }

        public static void PutList<T>(List<T> value) { }
        public static void PutArray<T>(params T[] value) { }
        public static void PutNested<T>(Outer<T>.Inner value) { }

        public static void F()
        {
            PutList<string>(null);
            PutArray<string>(null);
            PutArray<string>(null, "x");
            PutNested<string>(null);
        }
    }
}`)
        // Issue #5508: a parameter that a call passes a `null` literal is
        // widened to `T?`, so the literal stays `nil` there. The params
        // carrier cannot be widened (`...T`), so its element keeps the typed
        // default.
        Assert.Contains("PutList[T](value List[T]?)", printed, StringComparison.Ordinal)
        Assert.Contains("PutList[string](nil)", printed, StringComparison.Ordinal)
        Assert.Contains("default([]string)", printed, StringComparison.Ordinal)
        Assert.Contains("PutArray[string](default(string), \"x\")", printed, StringComparison.Ordinal)
        Assert.Contains("PutNested[T](value Outer[T].Inner?)", printed, StringComparison.Ordinal)
        Assert.Contains("PutNested[string](nil)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("nil!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func RectangularArrayWithNullElement_RendersNullableElementType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public object F(object a)
        {
            var grid = new object[,] { { a, null }, { a, a } };
            return grid[0, 0];
        }
    }
}`)
        Assert.Contains("[2, 2]object?", printed)
    }

    @Fact
    func BareRectangularArrayInitializerWithNullElement_RendersNullableElementType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public object[,] F()
        {
            object[,] grid = { { null } };
            return grid;
        }
    }
}`)
        Assert.Contains("[1, 1]object?", printed)
    }

    @Fact
    func ArrayWithoutNullElements_KeepsNonNullableElementType() {
        let printed = TranslateUnit(`
using System.Reflection;

namespace Demo
{
    public class C
    {
        public object F(ConstructorInfo ctor, object program)
        {
            return ctor.Invoke(new object[] { program, false });
        }
    }
}`)
        Assert.Contains("[]object{program, false}", printed)
        Assert.DoesNotContain("[]object?", printed)
    }

    @Fact
    func AnnotatedNullableElementArray_IsUnchanged() {
        let printed = TranslateUnit(`
#nullable enable
using System.Reflection;

namespace Demo
{
    public class C
    {
        public object F(ConstructorInfo ctor, object program)
        {
            return ctor.Invoke(new object?[] { program, null });
        }
    }
}`)
        Assert.Contains("[]object?{program, nil}", printed)
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
