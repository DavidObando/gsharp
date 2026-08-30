// <copyright file="Issue3682NullElementTargetTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3682: a C# array / slice literal that literally writes <c>null</c>
/// into a non-nullable reference element type. The C# is legal — the literal
/// lives in an oblivious file, so nothing is reported — but G#'s element type
/// really is non-nullable and gsc rejects the emitted <c>nil</c> (GS0155,
/// <c>Cannot convert type 'nil' to 'object'</c>). The literal's element type is
/// inferred AT the literal rather than pinned by a declaration, so the faithful
/// repair is to widen it to <c>T?</c>; a <c>!!</c> bridge would turn a clean C#
/// <c>new object[] { a, null }</c> into a runtime throw.
/// </summary>
public class Issue3682NullElementTargetTypeTests
{
    [Fact]
    public void ExplicitObjectArrayWithNullElements_RendersNullableElementType()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("[]object?{program, nil, false, nil}", printed);
    }

    [Fact]
    public void ObjectArrayLocalWithNullElement_RendersNullableElementType()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("[]object?{type, nil}", printed);
    }

    [Fact]
    public void ImplicitlyTypedArrayWithNullElements_RendersNullableElementType()
    {
        string printed = TranslateUnit(@"
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
            this.Check(new[] { null, null, ""d"" });
        }
    }
}");

        Assert.Contains(@"[]string?{nil, nil, ""d""}", printed);
    }

    [Fact]
    public void CollectionExpressionWithNullElements_RendersNullableElementType()
    {
        string printed = TranslateUnit(@"
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
            this.Check<string>([null, null, ""d""]);
        }
    }
}");

        Assert.Contains(@"[]string?{nil, nil, ""d""}", printed);
    }

    [Fact]
    public void RectangularArrayWithNullElement_RendersNullableElementType()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("[2, 2]object?", printed);
    }

    [Fact]
    public void ArrayWithoutNullElements_KeepsNonNullableElementType()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("[]object{program, false}", printed);
        Assert.DoesNotContain("[]object?", printed);
    }

    [Fact]
    public void AnnotatedNullableElementArray_IsUnchanged()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("[]object?{program, nil}", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
