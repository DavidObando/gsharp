// <copyright file="OahuFoundationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Targeted translation tests for the constructs closed in the Oahu.Foundation
/// round (issue #914, ADR-0115 §B/§G): conditional access, is-patterns,
/// array/typeof/default/sizeof expressions, nested and chained assignments,
/// <c>break</c>/<c>continue</c>/<c>do</c>/<c>lock</c>/local-function statements,
/// destructors, <c>this(...)</c> delegation, out-var declarations, reserved-word
/// and verbatim-identifier sanitization, width-bearing integer literals, the
/// catch-all <c>catch</c>, and unbound-generic <c>typeof</c>. Each snippet uses a
/// uniquely named user type and asserts a clean round-trip with the real G#
/// parser. The remaining Oahu.Foundation gaps (interface inheritance, generic
/// interface methods, unsafe pointers) are genuine G# language gaps and are
/// asserted to emit a structured <see cref="TranslationSeverity.Unsupported"/>
/// diagnostic rather than malformed G#.
/// </summary>
public class OahuFoundationTranslationTests
{
    /// <summary>
    /// ADR-0115 §B: a C# verbatim identifier (`@default`) loses its escape and a
    /// G# hard keyword used as an identifier (`type`) is suffixed with `_`, both
    /// consistently at declaration and reference sites so the code round-trips.
    /// </summary>
    [Fact]
    public void ReservedAndVerbatimIdentifiers_AreSanitizedConsistently()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class SanitizeX
    {
        private SanitizeX @default;
        public SanitizeX Resolve(System.Type type)
        {
            this.@default = this.@default ?? new SanitizeX();
            return this.@default;
        }
    }
}");

        Assert.Contains("default_", printed);
        Assert.Contains("type_ Type", printed);
        Assert.DoesNotContain("@default", printed);
    }

    /// <summary>
    /// ADR-0115 §B: a null-conditional chain (`a?.b`, `a?.b()`, `a?[i]`) maps to
    /// the matching G# `?`-receiver form.
    /// </summary>
    [Fact]
    public void ConditionalAccess_MapsToGSharpReceiverForm()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class CondX
    {
        public int? Length(string s) => s?.Length;
    }
}");

        Assert.Contains("?.Length", printed);
    }

    /// <summary>
    /// ADR-0115 §B: `x is null` / `x is not null` map to G# `== nil` / `!= nil`,
    /// and a type-test with a binder (`x is T t`) becomes a smart-cast `is T`
    /// test that drops the binder (the receiver is narrowed inside the block).
    /// </summary>
    [Fact]
    public void IsPattern_MapsToNilTestsAndSmartCast()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class IsX
    {
        public bool A(object o) => o is null;
        public bool B(object o) => o is not null;
        public string C(object o)
        {
            if (o is string s)
            {
                return s;
            }

            return null;
        }
    }
}");

        Assert.Contains("== nil", printed);
        Assert.Contains("!= nil", printed);
        Assert.Contains("is string", printed);
    }

    /// <summary>
    /// ADR-0115 §B: array literals (`new T[]{..}`, `new[]{..}`) map to the G#
    /// `[]T{..}` literal and `typeof(T)` / `default` / `default(T)` map to their
    /// native G# forms.
    /// </summary>
    [Fact]
    public void ArrayTypeofDefault_MapToNativeForms()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class ArrX
    {
        public int[] Nums() => new[] { 1, 2, 3 };
        public System.Type T() => typeof(string);
        public int D() => default;
        public string Dt() => default(string);
    }
}");

        Assert.Contains("[]", printed);
        Assert.Contains("typeof(string)", printed);
        Assert.Contains("default", printed);
    }

    /// <summary>
    /// ADR-0115 §B: an unbound-generic `typeof(IEnumerable&lt;&gt;)` has no
    /// bound type argument; it maps to the bare generic-definition name
    /// `typeof(IEnumerable)` (the only parseable G# form).
    /// </summary>
    [Fact]
    public void UnboundGenericTypeof_MapsToBareName()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class TypeofX
    {
        public System.Type T() => typeof(System.Collections.Generic.IEnumerable<>);
    }
}");

        Assert.Contains("typeof(IEnumerable)", printed);
    }

    /// <summary>
    /// ADR-0115 §B: `break`, `continue`, `do/while`, and a chained assignment
    /// (`a = b = c`) used as a statement all map to native G# forms.
    /// </summary>
    [Fact]
    public void LoopStatementsAndChainedAssignment_MapToNativeForms()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class LoopX
    {
        public int Run(int n)
        {
            int a = 0;
            int b = 0;
            do
            {
                a = b = n;
                if (a > 10)
                {
                    break;
                }

                continue;
            }
            while (a < 0);
            return a + b;
        }
    }
}");

        Assert.Contains("do {", printed);
        Assert.Contains("break", printed);
        Assert.Contains("continue", printed);
    }

    /// <summary>
    /// ADR-0115 §B: `lock (x) { .. }` lowers to a `Monitor.Enter`/`try`/`finally`
    /// `Monitor.Exit` pair and a local function maps to a `let name = lambda`.
    /// </summary>
    [Fact]
    public void LockAndLocalFunction_MapToNativeForms()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class LockX
    {
        private readonly object gate = new object();
        public int Run(int n)
        {
            int Twice(int v) => v * 2;
            lock (this.gate)
            {
                return Twice(n);
            }
        }
    }
}");

        Assert.Contains("Monitor.Enter", printed);
        Assert.Contains("Monitor.Exit", printed);
        Assert.Contains("Twice = ", printed);
    }

    /// <summary>
    /// ADR-0115 §B: a `: this(args)` constructor delegation maps to a
    /// `convenience init` and a `~T()` destructor maps to `deinit { .. }`.
    /// </summary>
    [Fact]
    public void ConvenienceInitAndDestructor_MapToNativeForms()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class CtorX
    {
        private readonly int v;
        public CtorX(int v)
        {
            this.v = v;
        }

        public CtorX()
            : this(0)
        {
        }

        ~CtorX()
        {
            System.Console.WriteLine(this.v);
        }
    }
}");

        Assert.Contains("convenience init", printed);
        Assert.Contains("deinit", printed);
    }

    /// <summary>
    /// ADR-0115 §B: `out var x` maps to the G# `out var x` declaration form, and
    /// an out-var binder that collides with a hard keyword (`func`) is suffixed.
    /// </summary>
    [Fact]
    public void OutVarDeclaration_MapsToOutVarForm()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class OutX
    {
        public bool Lookup(System.Collections.Generic.Dictionary<string, int> d)
        {
            return d.TryGetValue(""k"", out var func);
        }
    }
}");

        Assert.Contains("out var func_", printed);
    }

    /// <summary>
    /// ADR-0115 §B.12: a suffix-less integer literal whose C# type is wider or
    /// unsigned than int32 (`0xD800000000000000` is `ulong`) is emitted with the
    /// matching G# suffix so the lexer does not reject it.
    /// </summary>
    [Fact]
    public void WideIntegerLiteral_GetsWidthSuffix()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class CrcX
    {
        public const ulong Poly = 0xD800000000000000;
    }
}");

        Assert.Contains("0xD800000000000000UL", printed);
    }

    /// <summary>
    /// ADR-0115 §B: a bare catch-all `catch { }` (no declaration) has no G# form;
    /// the translator synthesizes the required typed binder
    /// `catch (ex Exception) { }`.
    /// </summary>
    [Fact]
    public void CatchAll_SynthesizesTypedBinder()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class CatchX
    {
        public int Run()
        {
            try
            {
                return 1;
            }
            catch
            {
                return 0;
            }
        }
    }
}");

        Assert.Contains("catch (ex Exception)", printed);
    }

    /// <summary>
    /// ADR-0115 §G: an interface that extends another interface
    /// (`interface IChild : IParent`) has no canonical G# form (the parser's
    /// interface production accepts no base clause). The translator records a
    /// structured Unsupported diagnostic and drops the base so the rest of the
    /// file still round-trips.
    /// </summary>
    [Fact]
    public void InterfaceInheritance_ReportsCompilerGap()
    {
        TranslationContext context = TranslateUnitWithContext(@"
namespace Demo
{
    public interface IParentX
    {
        void A();
    }

    public interface IChildX : IParentX
    {
        void B();
    }
}");

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported &&
                 d.Message.Contains("cannot declare base interfaces"));
    }

    /// <summary>
    /// ADR-0115 §G: a generic interface method (`bool IsPrimitive&lt;T&gt;()`) has no
    /// canonical G# form (the interface-method production accepts no `[T]`
    /// clause). The translator records a structured Unsupported diagnostic and
    /// drops the type-parameter list so the rest of the file still round-trips.
    /// </summary>
    [Fact]
    public void GenericInterfaceMethod_ReportsCompilerGap()
    {
        TranslationContext context = TranslateUnitWithContext(@"
namespace Demo
{
    public interface IGenX
    {
        bool IsPrimitive<T>();
    }
}");

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported &&
                 d.Message.Contains("cannot declare generic type parameters"));
    }

    /// <summary>
    /// ADR-0115 §G: an unsafe pointer type (`void*`/`byte*`) has no canonical G#
    /// form. The type mapper records a structured Unsupported diagnostic (kind
    /// <c>PointerType</c>) rather than emitting a type-less field; this gap is
    /// exercised end-to-end on the real <c>Win32FileIO.cs</c> in the corpus run.
    /// </summary>
    private static string TranslateUnit(string source)
    {
        (string printed, RoundTripResult result) = TranslateAndValidate(source);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static TranslationContext TranslateUnitWithContext(string source)
    {
        LoadedCSharpProject project = LoadProject(source);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        // The printed output must still round-trip: a genuine compiler gap is
        // reported as a diagnostic but never left as malformed, unparseable G#.
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Even with a reported gap the emitted G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return context;
    }

    private static (string Printed, RoundTripResult Result) TranslateAndValidate(string source)
    {
        LoadedCSharpProject project = LoadProject(source);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);
        return (printed, GSharpRoundTrip.Validate(printed));
    }

    private static LoadedCSharpProject LoadProject(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }
}
