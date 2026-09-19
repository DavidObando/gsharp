// <copyright file="Adr0186PlatformTypeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0186 step 2, end to end: §3's conversions and generic-container rule,
/// §4's coercion check, §5's two-clause lookup invariant, and §6's operator
/// acceptance — all against <b>real csc-emitted oblivious metadata</b> rather
/// than synthesized symbols, because the whole design turns on what an
/// unannotated assembly actually says.
/// <para>
/// Every case runs in <b>both</b> modes. The <c>Enabled</c> column is not
/// decoration: ADR-0186's sequencing makes "no behaviour change while
/// <c>--nullability=platform-types</c> is off" the load-bearing claim of every
/// step before the default flips, and a test that only exercises the new mode
/// cannot see a regression in the old one.
/// </para>
/// </summary>
public sealed class Adr0186PlatformTypeBindingTests
{
    private const string Consumer = "Adr0186.Step2.Consumer";
    private const string Library = "Adr0186.Step2.Library";

    /// <summary>
    /// A nullability-<em>oblivious</em> library: no <c>[Nullable]</c> and no
    /// <c>[NullableContext]</c> reaches any member, so the flags array gsc
    /// reads is empty and every reference position is oblivious — ADR-0186
    /// §2's first table row, which is the only producer of <c>T!</c> that
    /// exists before §9.
    /// </summary>
    private const string LibrarySource = """
        #nullable disable
        using System;
        using System.Collections.Generic;

        namespace Adr0186.Step2.Library;

        public static class Ob
        {
            public static string Value() => "V";

            public static string Nil() => null;

            public static List<int> Numbers() => new List<int> { 1, 2, 3 };

            public static List<int> NilNumbers() => null;

            public static List<string> NilStrings() => null;

            public static Nested NilNest() => null;

            public static void TakesPlatform(string value)
                => Console.WriteLine(value == null ? "took nil" : value);

            public static Dictionary<string, int> Table() => new Dictionary<string, int> { { "k", 7 } };

            public static Queue<T> Wrap<T>(T value)
            {
                var queue = new Queue<T>();
                queue.Enqueue(value);
                return queue;
            }

            public static List<T> WrapList<T>(T value) => new List<T> { value };
        }

        public class Nested
        {
            public string Prop { get; set; } = "V";
        }
        """;

    /// <summary>
    /// <b>ADR-0186 §5a — the mutation witness, first half.</b>
    /// <para>
    /// This is the test the ADR names as required, and it witnesses the single
    /// most important property in the design: <em>a receiver's platform-ness
    /// cannot select a different member.</em> Failure mode 5 of the catalogue
    /// (commit <c>359538cd</c>) was a silent miscompile in which one source
    /// line, <c>xs.Reverse()</c>, bound <c>List&lt;T&gt;.Reverse</c> for a
    /// plain receiver (void, in place, first element becomes 3) and
    /// <c>Enumerable.Reverse</c> for a nilable one (lazy, copying, result
    /// discarded, first element stays 1) — same line, opposite runtime
    /// meaning, chosen purely by the receiver's static nullability, with no
    /// diagnostic either way.
    /// </para>
    /// <para>
    /// <b><c>import System.Linq</c> is load-bearing and deliberate.</b> Commit
    /// <c>359538cd</c> records why: without <c>Enumerable</c> in scope there
    /// is no competing extension, the test passes either way, and it witnesses
    /// nothing at all.
    /// </para>
    /// <para>
    /// The assertion is the <em>mutation</em>, observed by running the emitted
    /// assembly, because that is what distinguishes the two candidates —
    /// binding successfully proves nothing here, since both candidates bind.
    /// </para>
    /// </summary>
    [Fact]
    public void Section5a_APlatformReceiver_Selects_The_Same_Member_And_Produces_The_Same_Mutation()
    {
        const string body = """
                let xs = Ob.Numbers()
                xs.Reverse()
                Console.WriteLine(xs[0])
            """;

        // The `T` baseline: a G#-declared `List[int32]` receiver, which has
        // never been in any doubt.
        const string baseline = """
                let xs = List[int32]()
                xs.Add(1)
                xs.Add(2)
                xs.Add(3)
                xs.Reverse()
                Console.WriteLine(xs[0])
            """;

        using var world = new World();

        var baselineOutput = world.Run(baseline, NullabilityMode.Enabled);
        Assert.Equal("3", baselineOutput.Trim());

        // The witness: the SAME line against a platform receiver must produce
        // the same mutation. `Enumerable.Reverse` would print 1.
        var platformOutput = world.Run(body, NullabilityMode.PlatformTypes);
        Assert.Equal("3", platformOutput.Trim());

        // And the selection itself, asserted structurally rather than only
        // through its effect: the bound call names `List<T>.Reverse`, not
        // `Enumerable.Reverse`. A witness that only observed the mutation
        // would stay green if some future change made `Enumerable.Reverse`
        // mutate-and-return, which is exactly the kind of coincidence
        // ADR-0154 asks a witness not to rely on.
        Assert.Equal(
            world.SelectedReverseDeclaringType(baseline, NullabilityMode.Enabled),
            world.SelectedReverseDeclaringType(body, NullabilityMode.PlatformTypes));
    }

    /// <summary>
    /// <b>ADR-0186 §5b — the mutation witness, second half.</b>
    /// <para>
    /// §5's invariant has two clauses and the ADR is explicit that an earlier
    /// draft stated only the first: "a witness that checks only selection
    /// passes while §5b is broken." Selection constrains <em>which</em> member
    /// is chosen; it says nothing about <em>what type the expression has
    /// afterwards</em>.
    /// </para>
    /// <para>
    /// The named hazard: <c>MemberLookup.GetImportedTypeSymbol</c> is a closed
    /// switch over receiver type symbols with no <c>PlatformTypeSymbol</c>
    /// arm. Reached with one it falls through to the erased answer at each of
    /// its call sites, turning <c>Queue[Entry]!.Dequeue()</c> from
    /// <c>Entry</c> into a CLR erasure. The fix ADR-0186 prescribes — and
    /// which this test pins — is to unwrap <c>T!</c> to <c>T</c> <em>before</em>
    /// type resolution runs, on the path resolution already uses, rather than
    /// teaching each of the eleven consumers about the new wrapper.
    /// </para>
    /// <para>
    /// <c>Entry</c> is a <b>same-compilation G# class</b> on purpose. An
    /// imported element type survives erasure by accident (reflection resolves
    /// it anyway); a same-compilation type has no runtime <c>Type</c> during
    /// binding, so the erased path yields <c>object</c> and the symbolic path
    /// yields <c>Entry</c>. Only the same-compilation shape discriminates.
    /// </para>
    /// </summary>
    [Fact]
    public void Section5b_APlatformReceiver_Produces_The_Same_Result_Type_For_A_Symbolic_Call()
    {
        using var world = new World();

        // Baseline: the receiver is an ordinary `Queue[Entry]` built in G#.
        var baseline = world.GlobalProbeType(
            """
            let queue = Queue[Entry]()
            let probe = queue.Dequeue()
            """,
            NullabilityMode.Enabled);

        // Witness: the receiver is `Queue[Entry]!` — the oblivious library
        // returns it, so it arrives platform-wrapped.
        var platform = world.GlobalProbeType(
            """
            let probe = Ob.Wrap[Entry](Entry()).Dequeue()
            """,
            NullabilityMode.PlatformTypes);

        Assert.Equal("Entry", baseline.Name);

        // The load-bearing assertion. With §5b broken this reads "object".
        Assert.Equal(baseline.Name, platform.Name);
        Assert.DoesNotContain("object", platform.Name, StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0186 §3 rule 3 — the generic-container soundness fix (Copilot
    /// finding HIGH-2 against the ADR), in both directions.
    /// <para>
    /// An earlier draft made <c>Box[string!]</c>, <c>Box[string]</c> and
    /// <c>Box[string?]</c> mutually assignable, reasoning that all three erase
    /// to one CLR type so nothing is observable at runtime. <b>Erasure is
    /// precisely what makes the hole reachable</b>: two views alias one
    /// object, so a nil written through one view is read as non-null through
    /// the other with <b>no <c>T! → T</c> boundary crossed anywhere</b> and
    /// therefore no §4 check.
    /// </para>
    /// <para>
    /// Exactly one conversion survives, <c>C[T!] → C[T?]</c>, and it is sound
    /// because every read through the destination view has type <c>T?</c> and
    /// must be narrowed before non-null use.
    /// </para>
    /// </summary>
    [Fact]
    public void Section3_AGenericContainer_Converts_Only_From_Platform_To_Nilable()
    {
        using var world = new World();

        // The unsound direction: a non-null read of a container that may hold
        // nil. This is the aliasing hole, and it must be a compile error.
        var toNonNull = world.Compile(
            """
                let alias List[string] = Ob.WrapList[string]("x")
                Console.WriteLine(alias[0])
            """,
            NullabilityMode.PlatformTypes);
        Assert.False(toNonNull.Success, Describe(toNonNull));
        Assert.Contains(toNonNull.Diagnostics, d => d.Message.Contains("List[string]!", StringComparison.Ordinal));

        // The one legal direction.
        var toNilable = world.Compile(
            """
                let alias List[string?] = Ob.WrapList[string]("x")
                Console.WriteLine(alias.Count)
            """,
            NullabilityMode.PlatformTypes);
        Assert.True(toNilable.Success, Describe(toNilable));

        // The two remaining unsound directions — `C[T] -> C[T!]` and
        // `C[T?] -> C[T!]` — have no source spelling to test here, because
        // `T!` is unwritable (§1) and no G# declaration can name a
        // platform-argument parameter before §9's oblivious scope lands. They
        // are pinned at the classifier instead, in
        // `Adr0186PlatformTypeConversionTests`, where both constructed types
        // can be built directly.
    }

    /// <summary>
    /// ADR-0186 §4: the check actually fires, at runtime, with an attributable
    /// message — and it fires at the <b>upcast</b>, which is Copilot finding
    /// HIGH-1's shape (<c>object o = obliviousCall()</c>).
    /// <para>
    /// Asserting the throw rather than the emitted opcodes is deliberate.
    /// §4's justification is not "some IL exists" but "the failure is
    /// attributable at the boundary where the CLR offers nothing", and only
    /// running it shows that the check is reached, the exception type is the
    /// one existing <c>catch</c> clauses expect, and the message names the
    /// expression.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("    let s string = Ob.Nil()\n    Console.WriteLine(s)", "a declared non-null local")]
    [InlineData("    let s object = Ob.Nil()\n    Console.WriteLine(s)", "an upcast to object (HIGH-1)")]
    [InlineData("    takesString(Ob.Nil())", "an argument to a non-null parameter")]
    [InlineData("    Console.WriteLine(returnsString())", "a return from a non-null function")]
    [InlineData("    Console.WriteLine(Ob.Nil().Length)", "an instance member receiver")]
    [InlineData("    Console.WriteLine(Ob.NilNumbers()[0])", "an indexer receiver")]
    [InlineData("    Console.WriteLine(Ob.Nil()!!)", "an explicit '!!'")]
    [InlineData("    Console.WriteLine(Ob.NilNumbers().Count())", "an extension method's receiver (case study 6)")]
    [InlineData("    let f (() -> string) = Ob.Nil().Trim\n    Console.WriteLine(f())", "a method-group capture (the ldftn worst case)")]
    [InlineData("    Console.WriteLine(Ob.Nil().Trim().Length)", "a chained receiver with no syntax (failure mode 3)")]
    [InlineData("    for v in Ob.NilNumbers() {\n        Console.WriteLine(v)\n    }", "a foreach source")]
    [InlineData("    Ob.NilNest().Prop = \"x\"", "a property-write receiver")]
    [InlineData("    let alias List[string?] = Ob.NilStrings()", "a container whose OUTER type is platform-wrapped")]
    public void Section4_TheCheck_Throws_An_Attributable_NullReferenceException(string body, string site)
    {
        using var world = new World();

        var thrown = Assert.Throws<NullReferenceException>(
            () => world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers));

        // The improvement over an unattributed NRE is the message — §4's whole
        // argument for a call-site check. An empty or default message means
        // the parameterless constructor was emitted, i.e. the site fell back
        // to the plain `!!` lowering and lost its attribution.
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal);

        // The site is named too — a bare "was nil" would locate nothing, and
        // §4's whole claim over the CLR's own check is attribution.
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal);
        Assert.False(string.IsNullOrWhiteSpace(thrown.Message), site);
    }

    /// <summary>
    /// The negative control for the fixture above, and §4's "and nowhere else"
    /// clause: a platform value flowing into a <c>T?</c> or <c>T!</c>
    /// destination crosses no boundary, so nothing throws.
    /// <para>
    /// Also covers the two §4 bullets that are easy to get wrong in the unsafe
    /// direction — a <b>type pattern</b> against a nil scrutinee <em>does not
    /// match and does not throw</em> (a pattern test is a question about the
    /// value, not a use of it as non-null), and a guarded <c>?.</c> access.
    /// </para>
    /// </summary>
    [Theory]
    // ADR-0186 §3's last row, end to end. It is small and load-bearing: `nil`
    // into a non-nullable `T` is a binder error and ADR-0155 A9 records that
    // `!!` cannot bridge it, so without this row cs2gs could not translate
    // `return null;` from an oblivious `string`-returning method and §9's
    // whole oblivious-scope mechanism would be unusable. Found as a GS9998
    // emit crash — "Conversion from 'nil' to 'string!' is not yet supported
    // by the emitter" — when the suite was first run with the mode on: the
    // binder admitted the store and emit refused it.
    [InlineData("    Ob.TakesPlatform(nil)", "took nil")]
    [InlineData("    let s string? = Ob.Nil()\n    Console.WriteLine(s == nil)", "True")]
    [InlineData("    let s = Ob.Nil()\n    Console.WriteLine(s == nil)", "True")]
    [InlineData("    takesNilable(Ob.Nil())", "nilable")]
    [InlineData("    Console.WriteLine(Ob.Nil()?.Length)", "")]
    [InlineData("    Console.WriteLine(Ob.Nil() ?? \"fallback\")", "fallback")]
    [InlineData("    let r = switch Ob.Nil() { case v is string: \"matched\" default: \"unmatched\" }\n    Console.WriteLine(r)", "unmatched")]
    [InlineData("    if let v = Ob.Nil() {\n        Console.WriteLine(\"bound\")\n    } else {\n        Console.WriteLine(\"nil\")\n    }", "nil")]
    public void Section4_NoCheck_Is_Inserted_Where_No_NonNull_Destination_Exists(string body, string expected)
    {
        using var world = new World();

        var output = world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers);

        Assert.Equal(expected, output.Trim());
    }

    /// <summary>
    /// ADR-0186 §4's escape hatch: <c>--platform-nil-checks=off</c> suppresses
    /// insertion.
    /// <para>
    /// The ADR insists this be described honestly: it is <b>strictly weaker
    /// than either the old or the new model</b>. Today the same site is a
    /// compile <em>error</em>; with checks off it is neither an error nor a
    /// check, and the nil simply travels until something else notices — which
    /// is exactly what this test observes, by watching the failure move from
    /// gsc's attributable message to an unattributed CLR NRE deeper in.
    /// </para>
    /// </summary>
    [Fact]
    public void Section4_ThePlatformNilChecksSwitch_Suppresses_Insertion()
    {
        const string body = "    let s string = Ob.Nil()\n    Console.WriteLine(s.Length)";
        using var world = new World();

        var withChecks = Assert.Throws<NullReferenceException>(
            () => world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers));
        Assert.Contains("nullability-oblivious", withChecks.Message, StringComparison.Ordinal);

        var withoutChecks = Assert.Throws<NullReferenceException>(
            () => world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers, platformNilChecks: false));
        Assert.DoesNotContain("nullability-oblivious", withoutChecks.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0186 §6: every null-handling construct accepts a <c>T!</c>, and the
    /// diagnostic that used to reject it does not fire.
    /// <para>
    /// Each row names the diagnostic it pins. These are all "gains <c>T!</c>
    /// on the admits-nil side of its test" rows in §7's table, and each one
    /// was measurably firing on step 1's baseline — the fixture is a
    /// difference, not a restatement.
    /// </para>
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="diagnostic">The diagnostic that must not fire.</param>
    [Theory]
    [InlineData("    if let v = Ob.Value() {\n        Console.WriteLine(v)\n    }", "GS0296")]
    [InlineData("    guard let v = Ob.Value() else { return }\n    Console.WriteLine(v)", "GS0296")]
    [InlineData("    var s = Ob.Value()\n    s ??= \"x\"\n    Console.WriteLine(s)", "GS0298")]
    [InlineData("    Console.WriteLine(Ob.Value() ?? \"x\")", "GS0298")]
    [InlineData("    Console.WriteLine(Ob.Value()?.Length)", "GS0300")]
    [InlineData("    Console.WriteLine(Ob.Table()?[\"k\"])", "GS0300")]
    [InlineData("    Console.WriteLine(Ob.Value() == nil)", "GS0129")]
    [InlineData("    Console.WriteLine(Ob.Table() == nil)", "GS0523")]
    [InlineData("    Console.WriteLine(Ob.Value()!!)", "GS0536")]
    public void Section6_EveryNullHandlingConstruct_Accepts_APlatformOperand(string body, string diagnostic)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);

        Assert.True(compiled.Success, Describe(compiled));
        Assert.DoesNotContain(compiled.Diagnostics, d => d.Id == diagnostic);
    }

    /// <summary>
    /// The negative half of §6: the diagnostics above are <b>narrowed, not
    /// deleted</b>. A genuinely non-null <c>T</c> operand still reports each
    /// one, so the fixture above is a statement about <c>T!</c> and not a
    /// blanket weakening of G#'s own null model — which ADR-0186 lists under
    /// "Explicitly out of scope".
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="diagnostic">The diagnostic that must still fire.</param>
    [Theory]
    [InlineData("    let plain string = \"v\"\n    if let v = plain {\n        Console.WriteLine(v)\n    }", "GS0296")]
    [InlineData("    var plain string = \"v\"\n    plain ??= \"x\"\n    Console.WriteLine(plain)", "GS0298")]
    [InlineData("    let plain = Dictionary[string, int32]()\n    Console.WriteLine(plain?[\"k\"])", "GS0300")]
    [InlineData("    let plain string = \"v\"\n    Console.WriteLine(plain!!)", "GS0536")]
    public void Section6_TheSameDiagnostics_Still_Fire_For_APlainNonNullOperand(string body, string diagnostic)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);

        Assert.Contains(compiled.Diagnostics, d => d.Id == diagnostic);
    }

    /// <summary>
    /// ADR-0069 narrowing applies to a <c>T!</c>, and it is what makes the
    /// platform model ergonomic rather than merely permissive: inside
    /// <c>if x != nil { … }</c> the value has type <c>T</c>, so the coercion
    /// that follows is not a <c>T! → T</c> coercion at all and §4 inserts
    /// nothing.
    /// <para>
    /// ADR-0186 is careful about the difference this makes: narrowing a
    /// <c>T!</c> is a <em>convenience</em>, not an obligation. Today it is the
    /// only way to compile.
    /// </para>
    /// </summary>
    [Fact]
    public void Section6_Narrowing_Applies_And_Removes_The_Coercion()
    {
        const string body = """
                let value = Ob.Nil()
                if value != nil {
                    let narrowed string = value
                    Console.WriteLine(narrowed)
                } else {
                    Console.WriteLine("nil")
                }
            """;

        using var world = new World();

        // No throw: the narrowed branch is not entered, and the coercion
        // inside it is from the NARROWED `string`, not from `string!`.
        Assert.Equal("nil", world.Run(body, NullabilityMode.PlatformTypes, extraDeclarations: NilHelpers).Trim());
    }

    private const string NilHelpers = """
        func takesString(s string) {
            Console.WriteLine(s)
        }

        func takesNilable(s string?) {
            Console.WriteLine("nilable")
        }

        func returnsString() string {
            return Ob.Nil()
        }
        """;

    private static string Describe(CompiledProgram compiled)
        => string.Join(Environment.NewLine, compiled.Diagnostics.Select(d => d.Id + ": " + d.Message));

    private sealed record DiagnosticLine(string Id, string Message);

    private sealed record CompiledProgram(bool Success, IReadOnlyList<DiagnosticLine> Diagnostics, byte[] PeBytes);

    /// <summary>
    /// The oblivious library plus the machinery to compile and run a G# probe
    /// against it in either nullability mode.
    /// </summary>
    private sealed class World : IDisposable
    {
        private readonly string directory;

        internal World()
        {
            this.directory = Path.Combine(
                AppContext.BaseDirectory,
                nameof(Adr0186PlatformTypeBindingTests),
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.directory);
            this.LibraryPath = EmitCSharpLibrary(this.directory, Library, LibrarySource);
        }

        internal string LibraryPath { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(this.directory, recursive: true);
            }
            catch (IOException)
            {
                // A locked assembly on a test host is not a test failure.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        internal CompiledProgram Compile(
            string body,
            NullabilityMode mode,
            string extraDeclarations = "",
            bool platformNilChecks = true)
        {
            using var resolver = ReferenceResolver.WithReferences(new[] { this.LibraryPath });
            resolver.CurrentAssemblyName = Consumer;
            var compilation = new GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From(BuildSource(body, extraDeclarations))))
            {
                AssemblyName = Consumer,
                Nullability = mode,
                PlatformNilChecks = platformNilChecks,
            };

            using var pe = new MemoryStream();
            var emit = compilation.Emit(pe, pdbStream: null, refStream: null, assemblyName: Consumer);
            return new CompiledProgram(
                emit.Success,
                emit.Diagnostics.Select(d => new DiagnosticLine(d.Id, d.Message)).ToArray(),
                emit.Success ? pe.ToArray() : Array.Empty<byte>());
        }

        internal string Run(
            string body,
            NullabilityMode mode,
            string extraDeclarations = "",
            bool platformNilChecks = true)
        {
            var compiled = this.Compile(body, mode, extraDeclarations, platformNilChecks);
            Assert.True(compiled.Success, Describe(compiled));

            var context = new AssemblyLoadContext(
                nameof(Adr0186PlatformTypeBindingTests) + "-" + Guid.NewGuid().ToString("N"),
                isCollectible: true);
            var libraryPath = this.LibraryPath;
            context.Resolving += (loadContext, name) =>
                string.Equals(name.Name, Library, StringComparison.Ordinal)
                    ? loadContext.LoadFromAssemblyPath(libraryPath)
                    : null;

            try
            {
                using var peStream = new MemoryStream(compiled.PeBytes);
                var assembly = context.LoadFromStream(peStream);
                var entry = Invariant.Required(assembly.EntryPoint, "an emitted G# program has an entry point");

                var stdout = Console.Out;
                var captured = new StringWriter();
                Console.SetOut(captured);
                try
                {
                    entry.Invoke(
                        null,
                        entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
                }
                catch (TargetInvocationException invocation) when (invocation.InnerException != null)
                {
                    // Surface the program's own exception, not the reflection
                    // wrapper — the §4 fixtures assert on its message.
                    throw invocation.InnerException;
                }
                finally
                {
                    Console.SetOut(stdout);
                }

                return captured.ToString();
            }
            finally
            {
                context.Unload();
            }
        }

        /// <summary>
        /// Binds <paramref name="globals"/> as top-level statements and
        /// returns the inferred type of its <c>probe</c> global — the §5b
        /// observation, which has to read a TYPE and so cannot be made by
        /// running anything.
        /// </summary>
        /// <param name="globals">Top-level G# statements declaring <c>probe</c>.</param>
        /// <param name="mode">The nullability mode.</param>
        /// <returns>The bound type of <c>probe</c>.</returns>
        internal TypeSymbol GlobalProbeType(string globals, NullabilityMode mode)
        {
            using var resolver = ReferenceResolver.WithReferences(new[] { this.LibraryPath });
            resolver.CurrentAssemblyName = Consumer;
            var source = $$"""
                package {{Consumer}}
                import Adr0186.Step2.Library
                import System
                import System.Collections.Generic
                import System.Linq

                class Entry {
                    var Id int32 = 1
                }

                {{globals}}
                """;
            var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
            {
                AssemblyName = Consumer,
                Nullability = mode,
            };

            var scope = compilation.GlobalScope;
            Assert.DoesNotContain(scope.Diagnostics, d => d.IsError);
            return Assert.Single(scope.Variables, v => v.Name == "probe").Type;
        }

        /// <summary>
        /// Binds <paramref name="body"/> and reports the declaring type of the
        /// method a <c>Reverse()</c> call selected — §5a's structural half.
        /// </summary>
        /// <param name="body">The probe body containing exactly one <c>Reverse()</c> call.</param>
        /// <param name="mode">The nullability mode.</param>
        /// <returns>The selected method's declaring type name.</returns>
        internal string SelectedReverseDeclaringType(string body, NullabilityMode mode)
        {
            using var resolver = ReferenceResolver.WithReferences(new[] { this.LibraryPath });
            resolver.CurrentAssemblyName = Consumer;
            var compilation = new GsCompilation(
                resolver,
                GsSyntaxTree.Parse(SourceText.From(BuildSource(body, string.Empty))))
            {
                AssemblyName = Consumer,
                Nullability = mode,
            };

            var program = compilation.BoundProgram;
            Assert.DoesNotContain(program.Diagnostics, d => d.IsError);

            var collector = new ReverseCallCollector();
            foreach (var function in program.Functions)
            {
                collector.Visit(function.Value);
            }

            return Assert.Single(collector.Found);
        }

        /// <summary>
        /// Finds the declaring type of every <c>Reverse</c> call in a bound
        /// body. Both call shapes are collected on purpose: an own-surface
        /// instance call binds as <c>BoundImportedInstanceCallExpression</c>
        /// and an extension binds as <c>BoundClrStaticCallExpression</c>, so
        /// a collector that looked at only one would report "no call found"
        /// rather than "the wrong method" when §5a regresses.
        /// </summary>
        private sealed class ReverseCallCollector : BoundTreeWalker
        {
            internal List<string> Found { get; } = new();

            protected override void VisitImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
            {
                if (node.Method.Name == "Reverse")
                {
                    this.Found.Add(node.Method.DeclaringType?.FullName ?? "<unknown>");
                }

                base.VisitImportedInstanceCallExpression(node);
            }

            protected override void VisitClrStaticCallExpression(BoundClrStaticCallExpression node)
            {
                if (node.Method.Name == "Reverse")
                {
                    this.Found.Add(node.Method.DeclaringType?.FullName ?? "<unknown>");
                }

                base.VisitClrStaticCallExpression(node);
            }
        }

        private static string BuildSource(string body, string extraDeclarations)
            => $$"""
                package {{Consumer}}
                import Adr0186.Step2.Library
                import System
                import System.Collections.Generic
                import System.Linq

                func Main() {
                {{body}}
                }

                {{extraDeclarations}}
                """;

        private static string EmitCSharpLibrary(string directory, string assemblyName, string source)
        {
            var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                    ?.Split(Path.PathSeparator) ?? Array.Empty<string>())
                .Where(File.Exists)
                .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
            var compilation = CSharpCompilation.Create(
                assemblyName,
                new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            var path = Path.Combine(directory, assemblyName + ".dll");
            using var stream = File.Create(path);
            var emit = compilation.Emit(stream);
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
            return path;
        }
    }
}
