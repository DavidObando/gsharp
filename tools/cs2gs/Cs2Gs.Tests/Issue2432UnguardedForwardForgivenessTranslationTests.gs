// <copyright file="Issue2432UnguardedForwardForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Translator-fidelity tests for issue #2432: an UNCONDITIONAL (no ternary,
/// no null-check guard) forward of a same-project promoted-nullable
/// field/property/local/parameter/method as the ENTIRE (possibly
/// parenthesized) body of a property/method whose own return type the
/// oblivious analyzer deliberately kept non-null (the same #1354/#2167
/// property-contract / forwarding-exclusion guardrail that left the forwarded
/// value tainted in the first place). The canonical shape is the real
/// `Oahu.Core` `Profile` class: an explicit interface property
/// implementation (`IAuthorization IProfile.Authorization =>
/// Authorization;`) that forwards a same-project concrete
/// `Authorization` property promoted to `Authorization?` through
/// unrelated constructor-parameter flow. Unlike the #2202 conditional-arm rule
/// ((cref:CSharpToGSharpTranslator.IsNullableTaintedArmOfReturnPreservingConditional)),
/// no ternary/switch conditional is required or present — the bare forward
/// itself, combined with the guardrail relationship, is sufficient evidence.
open class Issue2432UnguardedForwardForgivenessTranslationTests {
    /// The exact real-world Oahu.Core `Profile` shape: a concrete
    /// property (`Authorization`) promoted to `Authorization?` by
    /// unrelated constructor-parameter taint, forwarded UNCONDITIONALLY
    /// through an explicit interface property implementation whose own
    /// return type (`IAuthorization`) must stay non-null. Must assert
    /// `!!` so gsc accepts the `Authorization? -> IAuthorization`
    /// widening.
    @Fact
    func ExplicitInterfaceProperty_ArrowBody_UnconditionalForward_AssertsNonNull() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = "x" };
        }
    }

    public interface IProfile { IAuthorization Authorization { get; } }

    public class Profile : IProfile
    {
        public Profile()
        {
        }

        public Profile(Authorization authorization)
        {
            Authorization = authorization;
        }

        public Authorization Authorization { get; set; }

        IAuthorization IProfile.Authorization => Authorization;

        public static Profile FromFlag(int flag) => new Profile(Authorization.Create(flag));
    }
}`)
        let propIndex = printed.IndexOf("prop Authorization Authorization", StringComparison.Ordinal)
        Assert.True(propIndex >= 0, "Expected concrete Authorization property in output:\n" + printed)
        Assert.Contains("Authorization?", printed.Substring(propIndex, 40))
        let forwardIndex = printed.IndexOf("IAuthorization -> ", StringComparison.Ordinal)
        Assert.True(forwardIndex >= 0, "Expected explicit-interface forwarder in output:\n" + printed)
        let forwardLine = printed.Substring(forwardIndex, 40)
        Assert.Contains("Authorization!!", forwardLine)
    }

    /// Same shape, but the explicit implementation uses a block-bodied getter
    /// (`get { return Authorization; }`) instead of an arrow. Confirms
    /// the shared `IsBodyOfReturnPreservingMember` helper's
    /// (cref:Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax)
    /// dispatch is reached identically to the arrow-body form.
    @Fact
    func ExplicitInterfaceProperty_BlockBody_UnconditionalForward_AssertsNonNull() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = "x" };
        }
    }

    public interface IProfile { IAuthorization Authorization { get; } }

    public class Profile : IProfile
    {
        public Profile()
        {
        }

        public Profile(Authorization authorization)
        {
            Authorization = authorization;
        }

        public Authorization Authorization { get; set; }

        IAuthorization IProfile.Authorization
        {
            get { return Authorization; }
        }

        public static Profile FromFlag(int flag) => new Profile(Authorization.Create(flag));
    }
}`)
        Assert.Contains("Authorization!!", printed)
    }

    /// Method (not property) forwarding dimension: an explicit interface
    /// method implementation whose entire body is a call to another
    /// same-project method the taint fixpoint proved nullable. UNLIKE
    /// property-to-property forwarding, method-to-method forwarding is NOT
    /// excluded from the oblivious analyzer's own transitive-taint
    /// propagation, and issue #2423's bidirectional interface-method taint
    /// sync (`CollectInterfaceMethodEdges`) then promotes the interface
    /// method's OWN return type (`IAuthorization?`) right alongside it —
    /// so the forward already ends up `T? -> T?` and gsc accepts it with no
    /// bridge at all. This is a genuine NEGATIVE control demonstrating this
    /// fix's scope: it must NOT fire here, because nothing needs it to.
    @Fact
    func ExplicitInterfaceMethod_ForwardsTaintedCall_InterfaceContractAlreadyPromoted_NoForgivenessNeeded() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = "x" };
        }
    }

    public interface IProfile { IAuthorization GetAuthorization(); }

    public class Profile : IProfile
    {
        private Authorization ComputeAuthorization(int flag)
        {
            return Authorization.Create(flag);
        }

        IAuthorization IProfile.GetAuthorization() => ComputeAuthorization(0);
    }
}`)
        Assert.Contains("GetAuthorization() IAuthorization?", printed)
        Assert.DoesNotContain("ComputeAuthorization(0)!!", printed)
    }

    /// Field forwarding: a private same-project field promoted to nullable by
    /// constructor-parameter taint, forwarded unconditionally through an
    /// explicit interface property.
    @Fact
    func ExplicitInterfaceProperty_FieldForward_AssertsNonNull() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = "x" };
        }
    }

    public interface IProfile { IAuthorization Authorization { get; } }

    public class Profile : IProfile
    {
        private readonly Authorization _authorization;

        public Profile()
        {
        }

        public Profile(Authorization authorization)
        {
            _authorization = authorization;
        }

        IAuthorization IProfile.Authorization => _authorization;

        public static Profile FromFlag(int flag) => new Profile(Authorization.Create(flag));
    }
}`)
        Assert.Contains("_authorization!!", printed)
    }

    /// Non-contract, ordinary (no interface at all) property forwarding
    /// another property. The oblivious analyzer's forwarding-exclusion
    /// guardrail (#1354/#2167) refuses to propagate taint through
    /// property-to-property forwarding for ANY property, not only explicit
    /// interface implementations, so the outer property's own type also stays
    /// non-null here — this rule must forgive that case too. This is the same
    /// shape as `Issue2167TransitiveNullabilityTranslationTests
    /// .Oblivious_PropertyForwardingTaintedProperty_IsNotPromotedThroughCallOnlyEdge`,
    /// now additionally asserting the forgiveness `!!` gsc requires to
    /// actually compile it.
    @Fact
    func OrdinaryProperty_ForwardsAnotherTaintedProperty_AssertsNonNull() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Widget
    {
        public string Name { get; set; }
    }

    public class Container
    {
        public Container(Widget seed)
        {
            Work = seed;
        }

        public Widget Work { get; set; }

        public Widget Forward => Work;
    }

    public class Factory
    {
        public Widget MakeOrNull(int flag)
        {
            if (flag == 0) { return null; }
            return new Widget();
        }

        public Container Build(int flag)
        {
            return new Container(MakeOrNull(flag));
        }
    }
}`)
        Assert.Contains("Work!!", printed)
    }

    // NOTE (struct dimension, deliberately NOT covered here): a `struct`
    // implementing an interface via a constructor that is NOT eligible for
    // the T2 primary-constructor lift (e.g. it has more than one instance
    // constructor, matching the real-world multi-overload shape used for the
    // class dimension above) is silently translated to an EMPTY output —
    // the entire type declaration is dropped with no diagnostic. This
    // reproduces independent of any explicit interface implementation or
    // nullability at all (confirmed with a minimal `struct` implementing an
    // interface implicitly). It is a distinct, more severe pre-existing
    // defect than #2432 (silent data loss vs. a compile-error forgiveness
    // gap) and is out of scope for this fix; flagged for a follow-up issue
    // rather than fixed here.
    /// Multiple interface implementations: two distinct interfaces, each with
    /// their own explicit forwarding property reading the SAME promoted
    /// concrete property. Both forwarders must independently assert `!!`.
    @Fact
    func MultipleExplicitInterfaceImplementations_BothForward_BothAssertNonNull() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = "x" };
        }
    }

    public interface IProfile { IAuthorization Authorization { get; } }
    public interface IAccount { IAuthorization Authorization { get; } }

    public class Profile : IProfile, IAccount
    {
        public Profile()
        {
        }

        public Profile(Authorization authorization)
        {
            Authorization = authorization;
        }

        public Authorization Authorization { get; set; }

        IAuthorization IProfile.Authorization => Authorization;

        IAuthorization IAccount.Authorization => Authorization;

        public static Profile FromFlag(int flag) => new Profile(Authorization.Create(flag));
    }
}`)
        let firstForward = printed.IndexOf("IProfile) Authorization", StringComparison.Ordinal)
        let secondForward = printed.IndexOf("IAccount) Authorization", StringComparison.Ordinal)
        Assert.True(firstForward >= 0 && secondForward >= 0, "Expected both forwarders in output:\n" + printed)
        Assert.Contains("Authorization!!", printed.Substring(firstForward, 60))
        Assert.Contains("Authorization!!", printed.Substring(secondForward, 60))
    }

    /// Negative control: the interface member itself is ALREADY declared
    /// nullable (`IAuthorization?`) — a `?` annotation is syntactically
    /// legal (if unenforced, CS8632) even in an otherwise oblivious
    /// (`NullableContextOptions.Disable`) compilation. The forwarding
    /// property's own declared type is then already nullable, so
    /// `IsBodyOfReturnPreservingMember`'s own-type-promoted check
    /// rejects it — a normal `T? -> T?` flow needs no bridge, so no `!!`
    /// should be added to the forward.
    @Fact
    func NullableAnnotatedInterfaceContract_Forward_DoesNotAssertNonNull() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = "x" };
        }
    }

    public interface IProfile { IAuthorization? Authorization { get; } }

    public class Profile : IProfile
    {
        public Profile()
        {
        }

        public Profile(Authorization authorization)
        {
            Authorization = authorization;
        }

        public Authorization Authorization { get; set; }

        IAuthorization? IProfile.Authorization => Authorization;

        public static Profile FromFlag(int flag) => new Profile(Authorization.Create(flag));
    }
}`)
        let forwardIndex = printed.IndexOf("IAuthorization? -> ", StringComparison.Ordinal)
        Assert.True(forwardIndex >= 0, "Expected nullable-contract forwarder in output:\n" + printed)
        Assert.DoesNotContain("Authorization!!", printed.Substring(forwardIndex, 40))
    }

    /// Negative control: a GENUINELY nullable-enabled compilation
    /// (`NullableContextOptions.Enable`, project-wide — not merely a
    /// per-file pragma). (cref:CSharpToGSharpTranslator.IsObliviousCompilation)
    /// gates this entire rule to oblivious compilations, so a nullable-enabled
    /// project must be byte-identical to pre-#2432 behavior even for the
    /// exact same forwarding shape (where the real compiler's own nullable
    /// analysis — not cs2gs's oblivious taint fixpoint — already enforces the
    /// contract, and a genuine violation would be a C# compile error, not a
    /// cs2gs translation concern).
    @Fact
    func NullableEnabledCompilation_Forward_DoesNotAssertNonNull() {
        let source = `
#nullable enable
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; } = "";
    }

    public interface IProfile { IAuthorization Authorization { get; } }

    public class Profile : IProfile
    {
        public Profile(Authorization authorization)
        {
            Authorization = authorization;
        }

        public Authorization Authorization { get; set; }

        IAuthorization IProfile.Authorization => Authorization;
    }
}`
        let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
        let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
        let compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2432.EnabledInMemory",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
                .WithAllowUnsafe(true)
        )
        Assert.DoesNotContain(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument("Snippet.cs", tree, model)
        let context = TranslationContext(compilation, model, document.FilePath)
        let printed = PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain("Authorization!!", printed)
    }

    /// Negative control: the forwarded value is never null-tainted at all (no
    /// flow of `null` anywhere in the compilation), so the analyzer never
    /// promotes it and this rule's own `IsNullablePromotedValue` gate must
    /// reject it — no spurious `!!` on an already-safe forward.
    @Fact
    func UnTaintedForward_DoesNotAssertNonNull() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }
    }

    public interface IProfile { IAuthorization Authorization { get; } }

    public class Profile : IProfile
    {
        public Profile(Authorization authorization)
        {
            Authorization = authorization;
        }

        public Authorization Authorization { get; set; }

        IAuthorization IProfile.Authorization => Authorization;
    }
}`)
        Assert.DoesNotContain("Authorization!!", printed)
    }

    /// Full compile/run proof: the exact Oahu.Core `Profile` shape, once
    /// translated, must actually compile with the real `gsc` (zero
    /// errors) — the concrete assertion that GS0155 no longer reproduces.
    /// Gated on the compiler artifact being present (built via
    /// `GSharp.sln`); the translation-level assertions in the other
    /// tests in this file still validate the fix when only the cs2gs test
    /// project itself is built.
    @Fact
    func ExplicitInterfaceProperty_UnconditionalForward_CompilesWithGsc() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = "x" };
        }
    }

    public interface IProfile { IAuthorization Authorization { get; } }

    public class Profile : IProfile
    {
        public Profile()
        {
        }

        public Profile(Authorization authorization)
        {
            Authorization = authorization;
        }

        public Authorization Authorization { get; set; }

        IAuthorization IProfile.Authorization => Authorization;

        public static void Main()
        {
            var p = new Profile(Authorization.Create(0));
            System.Console.WriteLine(((IProfile)p).Authorization == null ? "null" : "not-null");
        }
    }
}`)
        let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2432-e2e")
        Directory.CreateDirectory(workDir)
        let gsPath = Path.Combine(workDir, "Profile.gs")
        let dllPath = Path.Combine(workDir, "Profile.dll")
        File.WriteAllText(gsPath, printed)
        let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated Profile shape with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
        )
        let (runExit, stdout) = RunDotnet("\"$dllPath\"")
        Assert.True(runExit == 0, "Translated Profile must run successfully. Output:\n" + stdout)
        Assert.Contains("null", stdout)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
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

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
