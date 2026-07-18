// <copyright file="Issue2432UnguardedForwardForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #2432: an UNCONDITIONAL (no ternary,
/// no null-check guard) forward of a same-project promoted-nullable
/// field/property/local/parameter/method as the ENTIRE (possibly
/// parenthesized) body of a property/method whose own return type the
/// oblivious analyzer deliberately kept non-null (the same #1354/#2167
/// property-contract / forwarding-exclusion guardrail that left the forwarded
/// value tainted in the first place). The canonical shape is the real
/// <c>Oahu.Core</c> <c>Profile</c> class: an explicit interface property
/// implementation (<c>IAuthorization IProfile.Authorization =&gt;
/// Authorization;</c>) that forwards a same-project concrete
/// <c>Authorization</c> property promoted to <c>Authorization?</c> through
/// unrelated constructor-parameter flow. Unlike the #2202 conditional-arm rule
/// (<see cref="CSharpToGSharpTranslator.IsNullableTaintedArmOfReturnPreservingConditional"/>),
/// no ternary/switch conditional is required or present — the bare forward
/// itself, combined with the guardrail relationship, is sufficient evidence.
/// </summary>
public class Issue2432UnguardedForwardForgivenessTranslationTests
{
    /// <summary>
    /// The exact real-world Oahu.Core <c>Profile</c> shape: a concrete
    /// property (<c>Authorization</c>) promoted to <c>Authorization?</c> by
    /// unrelated constructor-parameter taint, forwarded UNCONDITIONALLY
    /// through an explicit interface property implementation whose own
    /// return type (<c>IAuthorization</c>) must stay non-null. Must assert
    /// <c>!!</c> so gsc accepts the `Authorization? -&gt; IAuthorization`
    /// widening.
    /// </summary>
    [Fact]
    public void ExplicitInterfaceProperty_ArrowBody_UnconditionalForward_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = ""x"" };
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
}");

        int propIndex = printed.IndexOf("prop Authorization Authorization", StringComparison.Ordinal);
        Assert.True(propIndex >= 0, "Expected concrete Authorization property in output:\n" + printed);
        Assert.Contains("Authorization?", printed.Substring(propIndex, 40));

        int forwardIndex = printed.IndexOf("IAuthorization -> ", StringComparison.Ordinal);
        Assert.True(forwardIndex >= 0, "Expected explicit-interface forwarder in output:\n" + printed);
        string forwardLine = printed.Substring(forwardIndex, 40);
        Assert.Contains("Authorization!!", forwardLine);
    }

    /// <summary>
    /// Same shape, but the explicit implementation uses a block-bodied getter
    /// (<c>get { return Authorization; }</c>) instead of an arrow. Confirms
    /// the shared <c>IsBodyOfReturnPreservingMember</c> helper's
    /// <see cref="Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax"/>
    /// dispatch is reached identically to the arrow-body form.
    /// </summary>
    [Fact]
    public void ExplicitInterfaceProperty_BlockBody_UnconditionalForward_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = ""x"" };
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
}");

        Assert.Contains("Authorization!!", printed);
    }

    /// <summary>
    /// Method (not property) forwarding dimension: an explicit interface
    /// method implementation whose entire body is a call to another
    /// same-project method the taint fixpoint proved nullable. UNLIKE
    /// property-to-property forwarding, method-to-method forwarding is NOT
    /// excluded from the oblivious analyzer's own transitive-taint
    /// propagation, and issue #2423's bidirectional interface-method taint
    /// sync (<c>CollectInterfaceMethodEdges</c>) then promotes the interface
    /// method's OWN return type (<c>IAuthorization?</c>) right alongside it —
    /// so the forward already ends up `T? -&gt; T?` and gsc accepts it with no
    /// bridge at all. This is a genuine NEGATIVE control demonstrating this
    /// fix's scope: it must NOT fire here, because nothing needs it to.
    /// </summary>
    [Fact]
    public void ExplicitInterfaceMethod_ForwardsTaintedCall_InterfaceContractAlreadyPromoted_NoForgivenessNeeded()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = ""x"" };
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
}");

        Assert.Contains("GetAuthorization() IAuthorization?", printed);
        Assert.DoesNotContain("ComputeAuthorization(0)!!", printed);
    }

    /// <summary>
    /// Field forwarding: a private same-project field promoted to nullable by
    /// constructor-parameter taint, forwarded unconditionally through an
    /// explicit interface property.
    /// </summary>
    [Fact]
    public void ExplicitInterfaceProperty_FieldForward_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = ""x"" };
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
}");

        Assert.Contains("_authorization!!", printed);
    }

    /// <summary>
    /// Non-contract, ordinary (no interface at all) property forwarding
    /// another property. The oblivious analyzer's forwarding-exclusion
    /// guardrail (#1354/#2167) refuses to propagate taint through
    /// property-to-property forwarding for ANY property, not only explicit
    /// interface implementations, so the outer property's own type also stays
    /// non-null here — this rule must forgive that case too. This is the same
    /// shape as <c>Issue2167TransitiveNullabilityTranslationTests
    /// .Oblivious_PropertyForwardingTaintedProperty_IsNotPromotedThroughCallOnlyEdge</c>,
    /// now additionally asserting the forgiveness `!!` gsc requires to
    /// actually compile it.
    /// </summary>
    [Fact]
    public void OrdinaryProperty_ForwardsAnotherTaintedProperty_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("Work!!", printed);
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

    /// <summary>
    /// Multiple interface implementations: two distinct interfaces, each with
    /// their own explicit forwarding property reading the SAME promoted
    /// concrete property. Both forwarders must independently assert `!!`.
    /// </summary>
    [Fact]
    public void MultipleExplicitInterfaceImplementations_BothForward_BothAssertNonNull()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = ""x"" };
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
}");

        int firstForward = printed.IndexOf("IProfile) Authorization", StringComparison.Ordinal);
        int secondForward = printed.IndexOf("IAccount) Authorization", StringComparison.Ordinal);
        Assert.True(firstForward >= 0 && secondForward >= 0, "Expected both forwarders in output:\n" + printed);
        Assert.Contains("Authorization!!", printed.Substring(firstForward, 60));
        Assert.Contains("Authorization!!", printed.Substring(secondForward, 60));
    }

    /// <summary>
    /// Negative control: the interface member itself is ALREADY declared
    /// nullable (<c>IAuthorization?</c>) — a `?` annotation is syntactically
    /// legal (if unenforced, CS8632) even in an otherwise oblivious
    /// (<c>NullableContextOptions.Disable</c>) compilation. The forwarding
    /// property's own declared type is then already nullable, so
    /// <c>IsBodyOfReturnPreservingMember</c>'s own-type-promoted check
    /// rejects it — a normal `T? -&gt; T?` flow needs no bridge, so no `!!`
    /// should be added to the forward.
    /// </summary>
    [Fact]
    public void NullableAnnotatedInterfaceContract_Forward_DoesNotAssertNonNull()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = ""x"" };
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
}");

        int forwardIndex = printed.IndexOf("IAuthorization? -> ", StringComparison.Ordinal);
        Assert.True(forwardIndex >= 0, "Expected nullable-contract forwarder in output:\n" + printed);
        Assert.DoesNotContain("Authorization!!", printed.Substring(forwardIndex, 40));
    }

    /// <summary>
    /// Negative control: a GENUINELY nullable-enabled compilation
    /// (<c>NullableContextOptions.Enable</c>, project-wide — not merely a
    /// per-file pragma). <see cref="CSharpToGSharpTranslator.IsObliviousCompilation"/>
    /// gates this entire rule to oblivious compilations, so a nullable-enabled
    /// project must be byte-identical to pre-#2432 behavior even for the
    /// exact same forwarding shape (where the real compiler's own nullable
    /// analysis — not cs2gs's oblivious taint fixpoint — already enforces the
    /// contract, and a genuine violation would be a C# compile error, not a
    /// cs2gs translation concern).
    /// </summary>
    [Fact]
    public void NullableEnabledCompilation_Forward_DoesNotAssertNonNull()
    {
        string source = @"
#nullable enable
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; } = """";
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
}";

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2432.EnabledInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        string printed = PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.DoesNotContain("Authorization!!", printed);
    }

    /// <summary>
    /// Negative control: the forwarded value is never null-tainted at all (no
    /// flow of <c>null</c> anywhere in the compilation), so the analyzer never
    /// promotes it and this rule's own `IsNullablePromotedValue` gate must
    /// reject it — no spurious `!!` on an already-safe forward.
    /// </summary>
    [Fact]
    public void UnTaintedForward_DoesNotAssertNonNull()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.DoesNotContain("Authorization!!", printed);
    }

    /// <summary>
    /// Full compile/run proof: the exact Oahu.Core <c>Profile</c> shape, once
    /// translated, must actually compile with the real <c>gsc</c> (zero
    /// errors) — the concrete assertion that GS0155 no longer reproduces.
    /// Gated on the compiler artifact being present (built via
    /// <c>GSharp.sln</c>); the translation-level assertions in the other
    /// tests in this file still validate the fix when only the cs2gs test
    /// project itself is built.
    /// </summary>
    [Fact]
    public void ExplicitInterfaceProperty_UnconditionalForward_CompilesWithGsc()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string printed = TranslateOblivious(@"
namespace Demo
{
    public interface IAuthorization { string AuthorizationCode { get; } }

    public class Authorization : IAuthorization
    {
        public string AuthorizationCode { get; set; }

        public static Authorization Create(int flag)
        {
            if (flag == 0) { return null; }
            return new Authorization { AuthorizationCode = ""x"" };
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
            System.Console.WriteLine(((IProfile)p).Authorization == null ? ""null"" : ""not-null"");
        }
    }
}");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2432-e2e");
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Profile.gs");
        string dllPath = Path.Combine(workDir, "Profile.dll");
        File.WriteAllText(gsPath, printed);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated Profile shape with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated Profile must run successfully. Output:\n" + stdout);
        Assert.Contains("null", stdout);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
