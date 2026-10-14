// <copyright file="Issue4097AttributeConstructorNotFoundTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import Xunit

/// Issue #4097: an attribute whose arguments match no constructor of the
/// attribute type was DROPPED from the emitted assembly with no diagnostic at
/// all — exit 0, IL-verifies, runs, and the annotation the author wrote is
/// simply not in the metadata.
/// @remarks <b>The defect is silence, not selection.</b>
/// `ResolveAttributeConstructor` returning "no candidate matched" is the
/// correct answer for these programs; treating it as "nothing to emit" rather
/// than as an error is the bug. That silence is how issue #4073's
/// `Type[]` half stayed invisible: a widened `object[]` container
/// failed a `Type[]` parameter match, the WHOLE attribute vanished, and
/// the only symptom was a downstream framework not seeing an annotation that
/// was plainly in the source.
///
/// <b>Both drop sites.</b> The CLR-imported path bails when
/// `ResolveAttributeConstructor` returns null; the same-compilation user
/// attribute path (issue #1921) bails when
/// `TryResolveUserAttributeConstructor` returns false. Both are covered.
/// The user path has a second, honestly different cause — a constructor
/// parameter typed as an as-yet-unemitted user type, which the encoder cannot
/// write — and that gets its own message rather than being told it has the
/// wrong arguments.
///
/// <b>Emit-time, and why.</b> The check is the emitter's own
/// applicability rule (`ArgAssignable` over the RESOLVED constructor set,
/// including params-array expansion), and the emit pipeline has no
/// `DiagnosticBag` in scope. It reports through the same channel GS0546
/// uses: an `EmitDiagnosticException` carrying a diagnostic id, anchored
/// at the annotation. The consequence is that the first offending attribute
/// aborts emit, so a program with several reports one — the same limitation
/// GS0546 has, and still infinitely better than silence.
///
/// <b>The diagnostic immediately found a matcher gap, which is the whole
/// point of it.</b> Turning the drop into an error ran the Oahu corpus red on
/// `@ToString(typeof(ToStringConverterPath))`, against
/// `ToStringAttribute(Type type, string format = null)` — a trailing
/// OPTIONAL parameter, which no pass of `ResolveAttributeConstructor`
/// admitted. That program is legal C# and legal G#, so GS0583 was the WRONG
/// answer for it; the right one is to match the constructor and write the
/// default into the blob. It had been dropped from every Oahu assembly that
/// used it for as long as the corpus has been pinned, and nothing reported it.
/// Optional parameters are now a resolution pass of their own, placed before
/// params-array expansion because normal form beats expanded form — the same
/// order C# overload resolution uses. See `OmittedTrailingOptional` and
/// (cref:OmittedOptionalDefaults_AreWrittenIntoTheBlob), which asserts
/// the defaulted values are really in the metadata rather than merely
/// tolerated by the matcher.
///
/// <b>This is also the #4087 non-regression proof.</b> PR #4087 narrowed
/// `ArgAssignable`'s widened-array arm so `[]object{"x"}` no longer
/// satisfies a `string[]` constructor. That narrowing routed such programs
/// back into this silent drop. The `WidenedStringsAtStringArray` and
/// `ObjectContainerAtTypeArray` rows assert they now DIAGNOSE — which can
/// only happen if the narrowing still refuses them. If #4087 regressed, those
/// two rows would compile clean and fail here.
open class Issue4097AttributeConstructorNotFoundTests {
    @Theory
    @MemberData("UnmatchedRows")
    func AnAttributeMatchingNoConstructor_ReportsADiagnostic(name string, annotation string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4097_bad_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "P.dll")
            let source = Preamble + annotation + "\nclass " + name + ` {
}

Console.WriteLine("ok")
`
            let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            let ids = ErrorIds(log)
            // The failure message names BOTH halves of the defect on purpose.
            // "No diagnostic was reported" alone does not prove the bug this
            // issue describes; what makes it data LOSS is that the annotation
            // is missing from the metadata too. Measured on this branch's
            // parent, every row here reported `ids=[] attrs=[]` — clean
            // compile, attribute gone.
            let attributes = if File.Exists(appPath) {
                EmittedAttributeNames(appPath, libPath, name)
            } else {
                []string{"<emit aborted>"}
            }
            Assert.True(
                ids.Contains(ExpectedId, StringComparer.Ordinal),
                "'$name' must report $ExpectedId. ids=[${string.Join(", ", ids)}] " +
                    (`attrs=[` + "${string.Join(", ", attributes)}" + `]
Log:
` + "$log")
            )
            // Never dressed up as an internal compiler error.
            Assert.DoesNotContain("GS9998", ids)
            // And the row is genuinely not emitted — the diagnostic replaced the
            // silence, it did not paper over a half-written attribute.
            Assert.Equal([]string{"<emit aborted>"}, attributes)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Theory
    @MemberData("MatchedRows")
    func AnAttributeMatchingAConstructor_StillCompilesAndIsEmitted(
        name string,
        annotation string,
        expectedAttributes[]string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4097_ok_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "P.dll")
            let source = Preamble + annotation + "\nclass " + name + ` {
}

Console.WriteLine("ok")
`
            let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Empty(ErrorIds(log))
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$log"))
            IlVerifier.Verify(appPath, []string{libPath})
            Assert.Equal(expectedAttributes, EmittedAttributeNames(appPath, libPath, name))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The OTHER silent-drop cause on the user-attribute path: the arguments DO
    /// match, but the constructor parameter is typed as a same-compilation
    /// enum, which has no `ClrType` while the attribute blob is built.
    /// Measured on this branch's parent: no diagnostic, and the
    /// `NoteAttribute` row absent from `Widget`.
    /// @remarks This is EMITTED, not diagnosed. The program is legal — `csc`
    /// accepts the C# equivalent — so a diagnostic is the wrong answer, which
    /// is the same lesson the Oahu corpus taught about trailing optional
    /// parameters. Oahu carries this exact shape too
    /// (`@OahuCapability(CapabilityClass.Safe)`), so an earlier draft that
    /// reported GS0584 here took four of its apps red.
    ///
    /// Encoding it is a substitution, not a feature: a G# enum's
    /// underlying type is always `int32`, the bound value is already that
    /// constant rather than a symbol, and the constructor token and signature
    /// come from the emitted `MethodDef` — so only the value's WIDTH was
    /// ever missing. ECMA-335 II.23.3 writes an enum-typed fixed argument as
    /// its underlying primitive, which is what this now does.
    @Fact
    func AUserAttributeConstructorParameterTypedAsASourceEnum_IsEmitted() {
        const ProbeSource = `package P
import System

enum Status {
    Active,
    Retired
}

class NoteAttribute(Kind Status) : Attribute {
}

@Note(Status.Retired)
class Widget {
}

Console.WriteLine("ok")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4097_probe_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", ProbeSource + "\n", appPath, "/target:exe", "/reference:" + libPath)
            Assert.Empty(ErrorIds(log))
            Assert.True(File.Exists(appPath), (`the sample must compile. Log:
` + "$log"))
            IlVerifier.Verify(appPath, []string{libPath})
            // The row lands, and the blob carries the enum's UNDERLYING value.
            // `Retired` is 1, so a reader that got 0 would mean the argument had
            // been written as a default rather than as what the source named.
            Assert.Equal([]string{"NoteAttribute"}, EmittedAttributeNames(appPath, libPath, "Widget"))
            Assert.Equal([]object{1}, ConstructorArguments(appPath, libPath, "Widget"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Review feedback on PR #4137: an unprojectable parameter used to be
    /// recorded on ARITY alone, before applicability was settled, so it could
    /// outrank a constructor that projected fine and that the ARGUMENTS simply
    /// did not match. That ranking question — GS0583 (the arguments) vs GS0584
    /// (a parameter on a constructor never going to be chosen) — is retired by
    /// #4143: a constructor with an invalid attribute parameter type is now
    /// rejected at the ATTRIBUTE CLASS'S OWN DECLARATION (GS0585), before any
    /// use site exists to rank constructors against. There is no longer a
    /// legal G# program in which an unprojectable-parameter constructor
    /// survives to compete with an applicable one at a use site — every such
    /// program fails earlier, at the class declaration.
    /// @remarks `PairAttribute` has two single-argument constructors: one taking
    /// a same-compilation class (not a valid attribute parameter type), one
    /// taking a `string`. Before #4143 this class declaration compiled
    /// clean and the ranking question was only visible at `@Pair(1)`'s
    /// use site; now it never gets that far.
    @Fact
    func AnUnprojectableConstructorOverload_ReportsGS0585AtDeclaration() {
        const ProbeSource = `package P
import System

class Holder {
}

class PairAttribute : Attribute {
    init(value Holder) {
    }

    init(text string) {
    }
}

Console.WriteLine("ok")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4143_rank_").FullName
        try {
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", ProbeSource + "\n", appPath, "/target:exe")
            let ids = ErrorIds(log)
            Assert.True(
                ids.Contains("GS0585", StringComparer.Ordinal),
                "must report GS0585 on the declaration — the 'Holder'-typed overload is ill-formed " +
                    (
                    `regardless of whether it is ever chosen at a use site. Reported: [` +
                        "${string.Join(", ", ids)}" +
                        `]
Log:
` +
                        "$log"
                )
            )
            Assert.DoesNotContain("GS0584", ids)
            Assert.DoesNotContain("GS0583", ids)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4143: G# gained a bind-time CS0181 analogue (GS0585), which
    /// FLIPS this row. Before #4143, an ill-formed attribute constructor
    /// parameter reached emit unchecked and was reported once per USE as
    /// GS0584 — this test used to assert exactly that. Now the declaration
    /// itself is rejected as GS0585, earlier and independent of whether the
    /// attribute is ever applied, and GS0584 is unreachable for these shapes
    /// (it survives only as an emit-time backstop for a defect nothing else
    /// catches, which no longer includes "invalid parameter type" — every
    /// GS0584 case measured for #4097 was exactly this CS0181 set).
    /// @remarks The declaration is compiled with NO use site at all — no
    /// `@Boxed(...)` annotation anywhere in the source — which is the
    /// strongest form of this proof: `csc` reports CS0181 on a
    /// constructor whether or not the attribute is ever applied, because the
    /// mistake is in the attribute TYPE, not in any particular annotation.
    /// If this test's fix were reverted, the declaration alone would compile
    /// clean (no diagnostic at all — GS0584 needs a use site to fire), so a
    /// bare `Assert.True(ids.Contains("GS0585"))` without also asserting
    /// no use site exists would not distinguish the fixed behaviour from the
    /// old one falling through silently.
    /// @param name The row name.
    /// @param declaration The attribute class declaration.
    @Theory
    @InlineData("SourceClass", "class BoxedAttribute(Value Holder) : Attribute {\n}")
    @InlineData("SourceInterface", "class ThingAttribute(Value IThing) : Attribute {\n}")
    @InlineData("SourceDelegate", `delegate Sink(x int32);

class SinkAttribute(Value Sink) : Attribute {
}`)
    @InlineData("SourceMap", "class MapAttribute(Lookup map[string, int32]) : Attribute {\n}")
    func AnInvalidAttributeParameterType_ReportsGS0585AtDeclaration(name string, declaration string) {
        const ProbeSource = `package P
import System

class Holder {
}

interface IThing {
    func Get() int32;
}

`
        let tempDir = Directory.CreateTempSubdirectory("gs_4143_bad_param_").FullName
        try {
            let appPath = Path.Combine(tempDir, "P.dll")
            // No use site anywhere — proves the check fires at the
            // DECLARATION, not merely earlier at the same use site GS0584
            // used to require.
            let source = ProbeSource + declaration + `

Console.WriteLine("ok")
`
            let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            let ids = ErrorIds(log)
            Assert.True(
                ids.Contains("GS0585", StringComparer.Ordinal),
                (
                    `'` +
                        "$name" +
                        `' must report GS0585 on the declaration, with no use site anywhere. Reported: [` +
                        "${string.Join(", ", ids)}" +
                        `]
Log:
` +
                        "$log"
                )
            )
            Assert.DoesNotContain("GS0584", ids)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Code review (Copilot) on #4143: `Type.IsPrimitive` is also true
    /// for `System.IntPtr`/`System.UIntPtr` (`nint`/
    /// `nuint`), but ECMA-335 II.23.3's custom-attribute blob has no
    /// native-int element type and `csc` rejects both as CS0181.
    /// Measured before the fix: this declaration compiled clean, and a use
    /// site then reported the unrelated-looking GS0583 ("no constructor
    /// accepts (int32)") instead of naming the real problem.
    @Fact
    func ANativeIntAttributeParameter_ReportsGS0585() {
        const Source = `package P
import System

class NIntAttribute(Value nint) : Attribute {
}

Console.WriteLine("ok")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4143_nint_").FullName
        try {
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            let ids = ErrorIds(log)
            Assert.True(
                ids.Contains("GS0585", StringComparer.Ordinal),
                (
                    `'nint' must report GS0585 — ECMA-335 has no native-int attribute-argument shape. Reported: [` +
                        "${string.Join(", ", ids)}" +
                        `]
Log:
` +
                        "$log"
                )
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Code review (Copilot) on #4143: an explicit `init(...)`
    /// parameter whose type fails to resolve is bound as
    /// `TypeSymbol.Error` rather than dropped (unlike a primary
    /// constructor parameter, which is dropped and never reaches
    /// validation), so it used to reach GS0585 alongside the diagnostic
    /// already reported for the unresolved name — a misleading second
    /// error naming `type '?'`.
    @Fact
    func AnUnresolvedExplicitCtorParameterType_DoesNotAlsoReportGS0585() {
        const Source = `package P
import System

class BadAttribute : Attribute {
    init(value Nonexistent) {
    }
}

Console.WriteLine("ok")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4143_unresolved_").FullName
        try {
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            let ids = ErrorIds(log)
            Assert.Contains("GS0113", ids)
            Assert.DoesNotContain("GS0585", ids)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Code review (Copilot) on #4143: `DerivesFromSystemAttribute`
    /// reads flags (`IsAttributeClass`/`ImportedBaseType`) that
    /// are only set once a base's OWN `BindStructBaseAndInterfaces` has
    /// run. For a NESTED same-compilation base declared AFTER its derived
    /// sibling inside the same enclosing type, that has not happened yet at
    /// the point the derived type's primary constructor is validated.
    /// Measured before the fix: this declaration compiled clean with no
    /// GS0585, and the invalid parameter surfaced only as GS0584 if the
    /// attribute happened to be used.
    @Fact
    func ANestedAttributeDeclaredBeforeItsNestedBase_StillReportsGS0585AtDeclaration() {
        const Source = `package P
import System

class Holder {
}

class Outer {
    class DerivedAttribute(Value Holder) : BaseAttribute {
    }

    open class BaseAttribute : Attribute {
    }
}

Console.WriteLine("ok")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4143_nested_primary_").FullName
        try {
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            let ids = ErrorIds(log)
            Assert.True(
                ids.Contains("GS0585", StringComparer.Ordinal),
                (
                    `a nested attribute class declared before its nested base must still report GS0585. Reported: [` +
                        "${string.Join(", ", ids)}" +
                        `]
Log:
` +
                        "$log"
                )
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The explicit-constructor sibling of
    /// (cref:ANestedAttributeDeclaredBeforeItsNestedBase_StillReportsGS0585AtDeclaration).
    @Fact
    func ANestedAttributeExplicitCtorDeclaredBeforeItsNestedBase_StillReportsGS0585AtDeclaration() {
        const Source = `package P
import System

class Holder {
}

class Outer {
    class DerivedAttribute : BaseAttribute {
        init(value Holder) {
        }
    }

    open class BaseAttribute : Attribute {
    }
}

Console.WriteLine("ok")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4143_nested_explicit_").FullName
        try {
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            let ids = ErrorIds(log)
            Assert.True(
                ids.Contains("GS0585", StringComparer.Ordinal),
                (
                    `a nested attribute's explicit init(...) declared before its nested base must still report GS0585. Reported: [` +
                        "${string.Join(", ", ids)}" +
                        `]
Log:
` +
                        "$log"
                )
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The defaults of omitted optional parameters must be WRITTEN into the
    /// blob, not merely tolerated by the matcher. ECMA-335 II.23.3 gives a
    /// fixed-argument list one entry per constructor parameter, so a reader
    /// gets `7` and `"d"` back or the row is malformed.
    @Fact
    func OmittedOptionalDefaults_AreWrittenIntoTheBlob() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4097_opt_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "P.dll")
            let source = Preamble + `@Optionals(1)
class Defaulted {
}

` + `@ToString(typeof(Status))
class Converted {
}

` + "Console.WriteLine(\"ok\")\n"
            let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Empty(ErrorIds(log))
            Assert.True(File.Exists(appPath), (`the sample must compile. Log:
` + "$log"))
            IlVerifier.Verify(appPath, []string{libPath})
            Assert.Equal([]object{1, 7, "d"}, ConstructorArguments(appPath, libPath, "Defaulted"))
            // The `Type` argument reifies; the omitted `string format` is nil,
            // which is what `format = null` means.
            Assert.Equal([]object? {"P.Status", nil}, ConstructorArguments(appPath, libPath, "Converted"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The regression the cs2gs corpus caught: a params tail that absorbs
    /// nothing must be written as an EMPTY ARRAY, not as `nil`.
    /// @remarks Asserting the attribute merely lands is not enough — it landed before
    /// too. The blob was well-formed and said the wrong thing, which is why
    /// compile and ilverify both passed and only running the migrated tests
    /// exposed it. So the array itself is read back out of the metadata.
    @Fact
    func AParamsTailAbsorbingNothing_IsWrittenAsAnEmptyArray() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4097_params_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "P.dll")
            let source = Preamble + `@MemberDataLike("ShapeAreas")
class Empty {
}

` + `@MemberDataLike("Cases", 1, 2)
class Filled {
}

` + "Console.WriteLine(\"ok\")\n"
            let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Empty(ErrorIds(log))
            Assert.True(File.Exists(appPath), (`the sample must compile. Log:
` + "$log"))
            IlVerifier.Verify(appPath, []string{libPath})
            // Two slots: the name, then the params array. The array must be
            // present and EMPTY — `nil` here is what broke theory discovery.
            let empty = ConstructorArguments(appPath, libPath, "Empty")
            Assert.Equal(2, empty.Length)
            Assert.Equal("ShapeAreas", empty[0])
            Assert.NotNull(empty[1])
            Assert.Empty(cast[IEnumerable[CustomAttributeTypedArgument]](empty[1]))
            // And the expanded form still packs its elements.
            let filled = ConstructorArguments(appPath, libPath, "Filled")
            Assert.Equal(2, filled.Length)
            Assert.Equal("Cases", filled[0])
            Assert.Equal(
                []object{1, 2},
                (cast[IEnumerable[CustomAttributeTypedArgument]](filled[1])).Select(
                    (a CustomAttributeTypedArgument) -> a.Value!!
                )
                    .ToArray()
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// The diagnostic an unmatched attribute constructor reports.
        private const ExpectedId string = "GS0583"

        private const LibrarySource string = (`using System;

namespace HelperLib4097;

[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class NamesAttribute : Attribute
{
    public NamesAttribute(string[] values)
    {
        Values = values;
    }

    public string[] Values { get; }
}

[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class ManyAttribute : Attribute
{
    public ManyAttribute(Type[] values)
    {
        Values = values;
    }

    public Type[] Values { get; }
}

[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class MarkerAttribute : Attribute
{
    public MarkerAttribute(Type value)
    {
        Value = value;
    }

    public Type Value { get; }
}

// The shape the Oahu corpus uses, reproduced exactly: one required
// parameter and one OPTIONAL one. Legal C#, legal G#, and matched by no
// pass of the constructor resolver before #4097.
[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class ToStringAttribute : Attribute
{
    public ToStringAttribute(Type type, string format = null)
    {
        Type = type;
        Format = format;
    }

    public Type Type { get; }

    public string Format { get; }
}

// The xunit shapes the cs2gs corpus actually uses. ` + "`" + `MemberDataLike` + "`" + ` is
// the one that regressed: one required parameter plus a params tail
// absorbing ZERO trailing elements, so fewer arguments are supplied
// than there are slots — which is also true of a genuinely optional
// tail, and is why the two must be told apart.
[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class MemberDataLikeAttribute : Attribute
{
    public MemberDataLikeAttribute(string memberName, params object[] parameters)
    {
        MemberName = memberName;
        Parameters = parameters;
    }

    public string MemberName { get; }

    public object[] Parameters { get; }
}

[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class InlineDataLikeAttribute : Attribute
{
    public InlineDataLikeAttribute(params object[] data)
    {
        Data = data;
    }

    public object[] Data { get; }
}

[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public class OptionalsAttribute : Attribute
{
    public OptionalsAttribute(int first, int second = 7, string third = "d")
    {
        First = first;
        Second = second;
        Third = third;
    }

    public int First { get; }

    public int Second { get; }

    public string Third { get; }
}`)

        private const Preamble string = `package P
import System
import HelperLib4097

enum Status {
    Active,
    Retired
}

class NoteAttribute(Text string) : Attribute {
}

`

        /// Every shape whose arguments match no constructor. Each is its own
        /// compilation because the emit-time channel aborts on the first one.
        /// @returns Row name and the annotated declaration.
        func UnmatchedRows() sequence[[]object] {
            // The issue's own row, verbatim.
            yield[]object{"ObjectContainerAtTypeArray", "@Many([]object{1})"}
            // PR #4087's narrowing: a source `object[]` at a `string[]` parameter
            // is a call the author could not have written.
            yield[]object{"WidenedStringsAtStringArray", "@Names([]object{\"x\"})"}
            // Same narrowing, the `Type[]` parameter it was introduced for.
            yield[]object{"ObjectContainerOfTypesAtTypeArray", "@Many([]object{typeof(Status)})"}
            // No constructor of that arity at all — C#'s CS1729.
            yield[]object{"TooManyArguments", "@Marker(typeof(Status), typeof(Status))"}
            // Right arity, unassignable scalar — C#'s CS1503.
            yield[]object{"WrongScalarType", "@Marker(1)"}
            // The same-compilation user-attribute path (issue #1921).
            yield[]object{"UserAttributeWrongArity", "@Note(\"a\", \"b\")"}
            yield[]object{"UserAttributeWrongScalarType", "@Note(1)"}
            // Review feedback on PR #4137: `ManyAttribute(Type[] values)` declares
            // an ORDINARY array parameter, not `params`. Supplying two arguments
            // must not be absorbed into it — `csc` reports CS1729 for the same
            // program. Before the fix the matcher tested the parameter's shape
            // rather than `ParamArrayAttribute` and emitted a call the source
            // cannot write.
            yield[]object{"NonParamsArrayAbsorbingArguments", "@Many(typeof(Status), typeof(Status))"}
            // The same rule with one argument: a bare scalar at an ordinary array
            // parameter is not a one-element params call either.
            yield[]object{"NonParamsArraySingleArgument", "@Many(typeof(Status))"}
        }

        /// Shapes that DO match a constructor. They must keep compiling clean and
        /// keep landing a CustomAttribute row — a diagnostic that fires here would
        /// be a far worse regression than the silence it replaces.
        /// @returns Row name, annotated declaration, expected attribute names.
        func MatchedRows() sequence[[]object] {
            yield[]object{"FaithfulStringArray", "@Names([]string{\"x\"})", []string{"NamesAttribute"}}
            // The container #3684 widened, at the parameter it was widened FOR.
            yield[]object{"WidenedTypeArray", "@Many([]Type{typeof(Status)})", []string{"ManyAttribute"}}
            yield[]object{"ScalarType", "@Marker(typeof(Status))", []string{"MarkerAttribute"}}
            yield[]object{"UserAttributeMatched", "@Note(\"hello\")", []string{"NoteAttribute"}}
            // Issue #4097, found in the Oahu corpus rather than by reasoning: a
            // constructor reached through its trailing OPTIONAL parameter. Legal
            // C#, legal G#, and matched by NO pass of the resolver before this
            // change — so `@ToString(typeof(X))` was dropped from every Oahu
            // assembly that used it, silently, for as long as the corpus has been
            // pinned. The first draft of this fix reported GS0583 here, which is
            // the wrong answer: the program is one the language accepts, so the
            // attribute must be EMITTED with the default filled in.
            yield[]object{"OmittedTrailingOptional", "@ToString(typeof(Status))", []string{"ToStringAttribute"}}
            // Two omitted optionals, one of them a value type with a non-zero
            // default — the blob carries a value per parameter, so `7` and `"d"`
            // have to be read out of the metadata, not merely tolerated.
            yield[]object{"OmittedTrailingOptionals", "@Optionals(1)", []string{"OptionalsAttribute"}}
            // Issue #4097, caught by the cs2gs corpus gate: a params tail absorbing
            // ZERO trailing elements supplies fewer arguments than there are slots,
            // exactly as an omitted optional does. Conflating the two wrote `nil`
            // into the array slot instead of an empty array, and xunit stopped
            // seeing any data rows for the theory.
            yield[]object{
                "ParamsTailAbsorbingNothing",
                "@MemberDataLike(\"ShapeAreas\")",
                []string{"MemberDataLikeAttribute"}
            }
            // The same constructor with elements to absorb: the expanded form.
            yield[]object{
                "ParamsTailAbsorbingElements",
                "@MemberDataLike(\"Cases\", 1, 2)",
                []string{"MemberDataLikeAttribute"}
            }
            // A bare params constructor, the `[InlineData(...)]` shape.
            yield[]object{"BareParamsConstructor", "@InlineDataLike(1, \"small\")", []string{"InlineDataLikeAttribute"}}
            // Supplying an optional explicitly must keep the exact-arity path.
            yield[]object{"SuppliedTrailingOptional", "@ToString(typeof(Status), \"G\")", []string{"ToStringAttribute"}}
        }

        /// Reads the positional constructor arguments of the helper attribute on one type.
        /// @param assemblyPath The emitted assembly.
        /// @param libPath The referenced helper library.
        /// @param typeName The annotated type's simple name.
        /// @returns The argument values, in parameter order.
        private func ConstructorArguments(assemblyPath string, libPath string, typeName string)[]object? {
            let paths = List[string](TrustedPlatformAssemblies()){assemblyPath, libPath}
            using let context = MetadataLoadContext(PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)))
            let assembly = context.LoadFromAssemblyPath(assemblyPath)
            let target = assembly.GetTypes().Single((candidate Type) -> candidate.Name == typeName)
            // Same predicate as EmittedAttributeNames: a same-compilation user
            // attribute lives in the compilation's own package, not the helper lib.
            let attribute = target.GetCustomAttributesData().Single(
                (candidate CustomAttributeData) -> candidate
                    .AttributeType
                    .Namespace
                    ?.StartsWith("HelperLib4097", StringComparison.Ordinal) == true ||
                    candidate
                    .AttributeType
                    .Name == "NoteAttribute"
            )
            // Projected to a name WHILE the context is alive: a reflection `Type`
            // read after the load context is disposed throws.
            return attribute
                .ConstructorArguments
                .Select(
                (argument CustomAttributeTypedArgument) -> if argument.Value is Type type {
                    object((type.FullName ?? type.Name))
                } else {
                    argument.Value
                }
            )
                .ToArray()
        }

        private func ErrorIds(log string)[]string -> Regex
            .Matches(log, "error (GS[0-9]{4})")
            .Select((match Match) -> match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .ToArray()

        /// Names the user/helper attributes actually written onto one type.
        /// Distinguishes "encoded" from "dropped", which an argument list cannot.
        /// @param assemblyPath The emitted assembly.
        /// @param libPath The referenced helper library.
        /// @param typeName The annotated type's simple name.
        /// @returns The attribute type names, in metadata order.
        private func EmittedAttributeNames(assemblyPath string, libPath string, typeName string)[]string {
            let paths = List[string](TrustedPlatformAssemblies()){assemblyPath, libPath}
            using let context = MetadataLoadContext(PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)))
            let assembly = context.LoadFromAssemblyPath(assemblyPath)
            let target = assembly.GetTypes().Single((candidate Type) -> candidate.Name == typeName)
            return target
                .GetCustomAttributesData()
                .Where(
                (attribute CustomAttributeData) -> attribute
                    .AttributeType
                    .Namespace
                    ?.StartsWith("HelperLib4097", StringComparison.Ordinal) == true ||
                    attribute
                    .AttributeType
                    .Name == "NoteAttribute"
            )
                .Select((attribute CustomAttributeData) -> attribute.AttributeType.Name)
                .ToArray()
        }

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib4097",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib4097.dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
