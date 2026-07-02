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
/// parser. The Oahu.Foundation interface-inheritance, generic-interface-method,
/// and unsafe-pointer constructs now translate to canonical G# (interface
/// inheritance and generic interface methods became legal G# via issues #1006
/// and #1007; unsafe pointers map to the prefix <c>*T</c> form, the excepted
/// unsafe Win32-interop surface).
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
    /// Issue #914: a C# nullable *value* type (`T?` = `System.Nullable&lt;T&gt;`)
    /// exposes `.Value` / `.HasValue`, but G# models `T?` directly and has no
    /// `Nullable&lt;T&gt;` member surface (it relies on Kotlin-style smart-casts).
    /// So `x.Value` maps to the non-null assertion `x!!` (faithful to C#'s
    /// throw-if-null semantics) and `x.HasValue` maps to the null test
    /// `x != nil`. A user type with a member literally named `Value` is left
    /// untouched (the rewrite is gated on the receiver being `Nullable&lt;T&gt;`).
    /// </summary>
    [Fact]
    public void NullableValueTypeValueAndHasValue_MapToAssertionAndNilTest()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class NullVX
    {
        public int Unwrap(int? x) => x.Value;
        public bool Present(int? x) => x.HasValue;
    }

    public class BoxVX
    {
        public int Value => 7;
        public int Read(BoxVX b) => b.Value;
    }
}");

        Assert.Contains("x!!", printed);
        Assert.Contains("x != nil", printed);
        // The user `BoxVX.Value` member access is NOT a Nullable<T> receiver and
        // must remain a plain member access, never rewritten to `!!`.
        Assert.Contains("b.Value", printed);
    }

    /// <summary>
    /// Issue #914: G#'s smart-casts never narrow a property/field-access chain
    /// (only locals), so a member/element access on a nullable-reference *field*
    /// or *property* (declared `T?` or promoted to nullable per #1072) is rejected
    /// (GS0158/GS0116) regardless of any preceding null-guard. cs2gs must assert
    /// the receiver non-null (`field!!.Member`), which also matches C#'s
    /// throw-on-null semantics for the same access. A field that stays non-null
    /// (initialized, never null-checked/assigned) keeps a bare receiver.
    /// </summary>
    [Fact]
    public void NullableReferenceFieldReceiver_GetsNonNullAssertion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class ResFR { public bool Ok => true; }
    public class NullFieldRecvX
    {
        private ResFR res;
        private ResFR always = new ResFR();
        public void Init() { res = new ResFR(); }
        public bool Direct() => res.Ok;
        public bool Guarded() => !(res is null) && res.Ok;
        public bool Fixed() => always.Ok;
    }
}");

        // The null-checked (`res is null`) field `res` is promoted to `ResFR?`, so
        // every member-access receiver on it is asserted non-null.
        Assert.Contains("res!!.Ok", printed);
        Assert.DoesNotContain("res.Ok", printed);
        // A field that is never null-checked/assigned-null stays non-null and
        // keeps a bare receiver.
        Assert.Contains("always.Ok", printed);
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
    /// A local whose address is taken — passed by C# `ref`/`out` to an existing
    /// variable, or via an unsafe `&local` address-of — must be declared mutable
    /// (`var`), never immutable (`let`): gsc rejects taking the address of a `let`
    /// with GS9005 ("Cannot take address of constant").
    /// </summary>
    [Fact]
    public void LocalPassedByRef_IsDeclaredMutable()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class RefX
    {
        private static bool Fill(ref int slot) { slot = 1; return true; }
        public int Run()
        {
            int captured = 0;
            Fill(ref captured);
            return captured;
        }
    }
}");

        Assert.Contains("var captured", printed);
        Assert.DoesNotContain("let captured", printed);
    }

    [Fact]
    public void LocalWhoseAddressIsTaken_IsDeclaredMutable()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static unsafe class AddrX
    {
        private static bool Native(int* p) => *p == 0;
        public static bool Run()
        {
            int slot = 0;
            return Native(&slot);
        }
    }
}");

        Assert.Contains("var slot", printed);
        Assert.DoesNotContain("let slot", printed);
    }

    /// <summary>
    /// A C# delegate parameter with an explicit <c>= null</c> default (e.g.
    /// <c>Action&lt;T&gt; report = null</c>) is nullable by construction: a
    /// non-nullable G# function type cannot carry a <c>nil</c> default (gsc GS0265),
    /// so the parameter must render as the nullable arrow form
    /// <c>((T) -&gt; void)? = nil</c> now that nullable function types exist (#1399).
    /// </summary>
    [Fact]
    public void DelegateParameterWithNullDefault_RendersNullableArrow()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;
    public static class Notifier
    {
        public static void Run(int count, Action<int> report = null, Func<bool> cancel = null)
        {
            report?.Invoke(count);
        }
    }
}");

        Assert.Contains("report ((int32) -> void)? = nil", printed);
        Assert.Contains("cancel (() -> bool)? = nil", printed);
    }

    /// <summary>
    /// A C# delegate creation `new SomeDelegate(lambda)` wraps a lambda / method
    /// group in a named delegate type. G# has no delegate wrapper type — a
    /// delegate value IS a function value — so the redundant wrapper is unwrapped
    /// to its sole target expression. Constructing the mapped delegate type would
    /// otherwise leak the `ArrowTypeReference` AST node's CLR type name (issue
    /// #914).
    /// </summary>
    [Fact]
    public void DelegateConstructionWrappingLambda_UnwrapsToLambda()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System.Threading;
    public static class Poster
    {
        public static void Post(SynchronizationContext ctx)
        {
            ctx.Send(new SendOrPostCallback((state) => { }), null);
        }
    }
}");

        Assert.DoesNotContain("ArrowTypeReference", printed);
        Assert.DoesNotContain("SendOrPostCallback(", printed);
        Assert.Contains("ctx.Send((state object?) -> {", printed);
    }

    /// <summary>
    /// A C# bare `default` literal in a typed local (`TResult retval = default;`)
    /// is emitted as the self-typed `default(TResult)`. Roslyn reports the bare
    /// literal's natural type as the target type, so the local-declaration path
    /// omits the type clause and relies on inference — yet bare `default` has
    /// nothing to infer from, surfacing GS0362. Emitting `default(T)` keeps it
    /// valid in every position (issue #914, ADR-0100).
    /// </summary>
    [Fact]
    public void BareDefaultLiteral_RendersSelfTypedDefault()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Boxes
    {
        public static TResult MakeDefault<TResult>()
        {
            TResult retval = default;
            return retval;
        }
    }
}");

        Assert.Contains("default(TResult)", printed);
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
    /// (`interface IChild : IParent`) now translates to the canonical G# base
    /// clause `interface IChildX : IParentX { ... }` (G# parser supports
    /// interface inheritance since issue #1006). No Unsupported diagnostic is
    /// raised and the emitted G# round-trips through the real parser.
    /// </summary>
    [Fact]
    public void InterfaceInheritance_EmitsBaseClause()
    {
        (string printed, TranslationContext context) = TranslateUnitWithPrinted(@"
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

        Assert.Contains("interface IChildX : IParentX", printed);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// ADR-0115 §G: a generic interface method (`bool IsPrimitive&lt;T&gt;()`) now
    /// translates to the canonical bodyless G# form `func IsPrimitive[T]() bool;`
    /// (G# parser supports generic methods in interfaces since issue #1007). No
    /// Unsupported diagnostic is raised and the emitted G# round-trips.
    /// </summary>
    [Fact]
    public void GenericInterfaceMethod_EmitsTypeParameterList()
    {
        (string printed, TranslationContext context) = TranslateUnitWithPrinted(@"
namespace Demo
{
    public interface IGenX
    {
        bool IsPrimitive<T>();

        string Format<T>(T value);
    }
}");

        Assert.Contains("func IsPrimitive[T]() bool;", printed);
        Assert.Contains("func Format[T](value T) string;", printed);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// ADR-0115 §G: an unsafe pointer type (C# postfix `T*`) now translates to
    /// the canonical G# PREFIX pointer form `*T`; a `void*` (no element type)
    /// maps to the faithful void-element pointer `*void` (ADR-0122 §3 / issue
    /// #1033), distinct from the byte pointer `*uint8`. The emitted G#
    /// round-trips through the parser. No Unsupported diagnostic is raised — the
    /// binder later steers callers to `ref`/`out`/`in` (GS0243) on the excepted
    /// unsafe Win32-interop surface, which the corpus compile stage exercises
    /// on the real Win32FileIO.cs.
    /// </summary>
    [Fact]
    public void PointerType_EmitsCanonicalPrefixForm()
    {
        (string printed, TranslationContext context) = TranslateUnitWithPrinted(@"
namespace Demo
{
    public static unsafe class PtrX
    {
        [System.Runtime.InteropServices.DllImport(""kernel32.dll"")]
        public static extern bool ReadFile(void* pBuffer, int* pBytesRead, byte* pBuf);
    }
}");

        Assert.Contains("pBuffer *void", printed);
        Assert.Contains("pBytesRead *int32", printed);
        Assert.Contains("pBuf *uint8", printed);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }


    /// <summary>
    /// A C# `new` of a primitive type keyword (e.g. `new string(char, int)`) must be
    /// emitted with the qualified CLR type name (`System.String(' ', n)`), because the
    /// G# alias `string` is a language keyword and is not callable as a constructor —
    /// emitting `string(...)` yields GS0130 ("Function 'string' doesn't exist").
    /// </summary>
    [Fact]
    public void NewStringFromCharCount_EmitsQualifiedClrConstructor()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class PadX
    {
        public string Pad(int n) => new string(' ', n);
    }
}");

        Assert.Contains("System.String(' ', n)", printed);
        Assert.DoesNotContain("string(' '", printed);
    }

    /// <summary>
    /// Issue #914 (GS0128): C# `!x.HasValue` on a nullable value type must
    /// parenthesize the mapped null test, otherwise `.HasValue` -> `x != nil`
    /// composes under the prefix `!` as `!x != nil`, which G# parses as
    /// `(!x) != nil` (GS0128, `!` undefined for the nullable type). The correct
    /// form is `!(x != nil)`.
    /// </summary>
    [Fact]
    public void NegatedHasValue_ParenthesizesNullTest()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class NegHasX
    {
        public bool Missing(System.DateTime? when) => !when.HasValue;
    }
}");

        Assert.Contains("!(when != nil)", printed);
        Assert.DoesNotContain("!when != nil", printed);
    }

    /// <summary>
    /// Issue #914 (GS0131): directly invoking a nullable-reference delegate
    /// *field* (`handler(args)` where `handler` is `((T) -&gt; R)?`) needs a `!!`
    /// assertion on the callee — G# smart-casts only locals, never a field/
    /// property chain, so the field stays nullable and "is not a function" even
    /// inside an `if handler != nil` guard. cs2gs must emit `handler!!(args)`.
    /// </summary>
    [Fact]
    public void NullableDelegateFieldInvocation_AssertsCalleeNonNull()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class DelInvX
    {
        private readonly System.Func<int, int>? handler;
        public DelInvX(System.Func<int, int>? h) => this.handler = h;
        public int Fire(int value)
        {
            if (this.handler != null)
            {
                return this.handler(value);
            }
            return 0;
        }
    }
}");

        Assert.Contains("this.handler!!(value)", printed);
    }

    private static string TranslateUnit(string source)
    {
        (string printed, RoundTripResult result) = TranslateAndValidate(source);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static (string Printed, TranslationContext Context) TranslateUnitWithPrinted(string source)
    {
        LoadedCSharpProject project = LoadProject(source);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        // The emitted G# must round-trip through the real parser even on the
        // unsafe-interop surface (the binder, not the parser, flags GS0243).
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Emitted G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return (printed, context);
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
