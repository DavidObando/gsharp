// <copyright file="Issue5520StaticInitializerAccessNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
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

/// Issue #5520: ADR-0208 rows R11 and R15 count a static field, property or event access of a type with a
/// non-literal `shared` field initializer (or a static constructor) as a call, because the type initializer runs
/// at the first access. gsc removes member-path and by-reference facts there, as it does at a call. C# flow
/// analysis keeps the fact, so the translated read needs its own `!!`. The translator answers with the one
/// decision `NodeRunsStaticTypeInitializer`; each test names the change that would make it fail. Each test also
/// compiles the translated G# with the repository's `gsc.dll`, so a missing `!!` fails as `GS0158` and a bare read
/// that gsc no longer narrows cannot pass.
open class Issue5520StaticInitializerAccessNarrowingTests {
    /// Mutation witness for this row and the loop, `using`, property and event, and inherited-field rows:
    /// `NodeRunsStaticTypeInitializer` returns false.
    @Fact
    func OutParameter_ReadAfterAStaticFieldWithACallInitializer_IsAsserted() {
        let printed = Translate(`
public sealed class TypeSym
{
    public static readonly TypeSym Error = new TypeSym();
    public System.Type? ClrType => null;
}
public class Demo
{
    static TypeSym? Make() => null;
    public static bool Run(out TypeSym? substituted)
    {
        substituted = Make();
        if (substituted is null || substituted == TypeSym.Error)
        {
            return false;
        }
        return substituted.ClrType is null;
    }
}`)
        Assert.Contains("substituted!!.ClrType", printed)
        AssertCompilesWithGsc(printed)
    }

    /// The member-path shape of the LambdaBinder site (`node.Expression` guarded, then `kind == Kind.Void`, then the
    /// read). The translator never trusts gsc to narrow a member path that C# flow proves non-null, so the static
    /// access needs no rule of its own; this row pins the result. Mutation witness:
    /// `GSharpExpressionIsStaticallyNonNull` answers true for a member access whose C# flow state is non-null.
    @Fact
    func MemberPath_ReadAfterAStaticFieldInALaterStatement_IsAsserted() {
        let printed = Translate(`
public sealed class Kind
{
    public static readonly Kind Void = new Kind();
}
public sealed class Node
{
    public readonly string? Expression = null;
}
public class Demo
{
    public static int Run(Node node, Kind kind)
    {
        if (node.Expression == null)
        {
            return 0;
        }
        if (kind == Kind.Void)
        {
            return 1;
        }
        return node.Expression.Length;
    }
}`)
        Assert.Contains("node.Expression!!.Length", printed)
        AssertCompilesWithGsc(printed)
    }

    @Fact
    func OutParameter_ReadAfterAStaticFieldReadInALoop_IsAsserted() {
        let printed = Translate(`
public sealed class Holder
{
    public static readonly System.Collections.Generic.List<int> Cache = new System.Collections.Generic.List<int>();
}
public class Demo
{
    static string? Pick() => null;
    public static int Run(out string? text, int n)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        var total = 0;
        for (var i = 0; i < n; i++)
        {
            total += Holder.Cache.Count;
        }
        return total + text.Length;
    }
}`)
        Assert.Contains("text!!.Length", printed)
        AssertCompilesWithGsc(printed)
    }

    @Fact
    func OutParameter_ReadInsideAUsingOverAStaticField_IsAsserted() {
        let printed = Translate(`
public sealed class Holder
{
    public static readonly System.IO.MemoryStream Stream = new System.IO.MemoryStream();
}
public class Demo
{
    static string? Pick() => null;
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        using (Holder.Stream)
        {
            return text.Length;
        }
    }
}`)
        Assert.Contains("text!!.Length", printed)
        AssertCompilesWithGsc(printed)
    }

    @Fact
    func OutParameter_ReadAfterAStaticPropertyAndEventOfAStaticConstructorType_IsAsserted() {
        let printed = Translate(`
public sealed class Hub
{
    static Hub() { Name = "x"; }
    public static string Name { get; private set; }
    public static event System.Action? Changed;
    public static void Raise() => Changed?.Invoke();
}
public class Demo
{
    static string? Pick() => null;
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        var n = Hub.Name.Length;
        return n + text.Length;
    }
}`)
        Assert.Contains("text!!.Length", printed)
        AssertCompilesWithGsc(printed)
    }

    /// `+1` converts to `uint`, so the translation is `uint32(+1)`, which gsc counts as code. Mutation witness: the
    /// conversion is read on the literal operand instead of the whole initializer.
    @Fact
    func OutParameter_ReadAfterAStaticFieldWithASignedConvertedLiteral_IsAsserted() {
        let printed = Translate(`
public sealed class Limits
{
    public static uint Max = +1;
}
public class Demo
{
    static string? Pick() => null;
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        var n = Limits.Max;
        return (int)n + text.Length;
    }
}`)
        Assert.Contains("text!!.Length", printed)
        AssertCompilesWithGsc(printed)
    }

    /// A static event subscription alone between the guard and the read. Mutation witness: an event does not count
    /// in `NodeRunsStaticTypeInitializer`.
    @Fact
    func OutParameter_ReadAfterAStaticEventSubscription_IsAsserted() {
        let printed = Translate(`
public sealed class Hub
{
    public static readonly object Gate = new object();
    public static event System.Action? Changed;
    public static void Raise() => Changed?.Invoke();
}
public class Demo
{
    static string? Pick() => null;
    static void Handler() { }
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        Hub.Changed += Handler;
        return text.Length;
    }
}`)
        Assert.Contains("text!!.Length", printed)
        AssertCompilesWithGsc(printed)
    }

    /// `-2147483648` is the `int32` literal `int32.MinValue` for gsc too, so the read stays bare and the translation
    /// compiles. Mutation witness: the compiler's literal initializer test omits the `int32.MinValue` rule.
    @Fact
    func OutParameter_ReadAfterAStaticFieldWithTheInt32MinValueLiteral_StaysBare() {
        let printed = Translate(`
public sealed class Limits
{
    public static int Min = -2147483648;
}
public class Demo
{
    static string? Pick() => null;
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        var n = Limits.Min;
        return n + text.Length;
    }
}`)
        Assert.DoesNotContain("text!!", printed)
        AssertCompilesWithGsc(printed)
    }

    /// Mutation witness for this row and the constant and construction rows: `NodeRunsStaticTypeInitializer` counts
    /// every name and member access.
    @Fact
    func OutParameter_ReadAfterAStaticFieldOfALiteralOnlyType_StaysBare() {
        let printed = Translate(`
public sealed class Limits
{
    public static int Max = 10;
    public static readonly int Min = -1;
    public static readonly string? Name = null;
}
public class Demo
{
    static string? Pick() => null;
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        var n = Limits.Max + Limits.Min;
        return n + text.Length;
    }
}`)
        Assert.DoesNotContain("text!!", printed)
        AssertCompilesWithGsc(printed)
    }

    @Fact
    func OutParameter_ReadAfterAConstOfATypeWithACallInitializer_StaysBare() {
        let printed = Translate(`
public sealed class Mixed
{
    public const int Limit = 3;
    public static readonly object Gate = new object();
}
public class Demo
{
    static string? Pick() => null;
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        return Mixed.Limit + text.Length;
    }
}`)
        Assert.DoesNotContain("text!!", printed)
        AssertCompilesWithGsc(printed)
    }

    /// `Mixed` is a struct with no field initializer, so its construction runs no user code. (gsc also kills the fact
    /// of a by-reference parameter at a class construction through a constructor call, which is not this rule: #5562.)
    @Fact
    func OutParameter_ReadAfterAConstructionAndAnInstanceMember_StaysBare() {
        let printed = Translate(`
public struct Mixed
{
    public int Id;
    public static readonly object Gate = new object();
}
public class Demo
{
    static string? Pick() => null;
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        var made = new Mixed();
        return made.Id + text.Length;
    }
}`)
        Assert.DoesNotContain("text!!", printed)
        AssertCompilesWithGsc(printed)
    }

    /// Mutation witness: the early return for a variable that is neither closure-assigned nor by-reference is removed.
    @Fact
    func PlainLocal_ReadAfterAStaticFieldWithACallInitializer_StaysBare() {
        let printed = Translate(`
public sealed class Holder
{
    public static readonly object Gate = new object();
}
public class Demo
{
    public static int Run(string? input)
    {
        string? text = input;
        if (text is null)
        {
            return 0;
        }
        var g = Holder.Gate;
        return text.Length;
    }
}`)
        Assert.DoesNotContain("text!!", printed)
        AssertCompilesWithGsc(printed)
    }

    /// Mutation witness: the walk between the guard and the read enters function literals.
    @Fact
    func OutParameter_StaticFieldReadOnlyInsideAFunctionLiteral_StaysBare() {
        let printed = Translate(`
public sealed class Holder
{
    public static readonly object Gate = new object();
}
public class Demo
{
    static string? Pick() => null;
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        System.Func<object> f = () => Holder.Gate;
        return text.Length;
    }
}`)
        Assert.DoesNotContain("text!!", printed)
        AssertCompilesWithGsc(printed)
    }

    /// `Derived` declares no initializer; the static field belongs to `Base`, which runs the initializer.
    @Fact
    func OutParameter_ReadAfterAnInheritedStaticField_UsesTheDeclaringType() {
        let printed = Translate(`
public class Base
{
    public static readonly object Gate = new object();
}
public class Derived : Base { }
public class Demo
{
    static string? Pick() => null;
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        var g = Derived.Gate;
        return text.Length;
    }
}`)
        Assert.Contains("text!!.Length", printed)
        AssertCompilesWithGsc(printed)
    }

    shared {
        private func AssertCompilesWithGsc(printed string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(
                AppContext.BaseDirectory,
                "Issue5520StaticInitializerAccessNarrowingTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Probe.gs")
                let dllPath = Path.Combine(workDir, "Probe.dll")
                File.WriteAllText(gsPath, printed)
                let (exitCode, output) = RunDotnet(
                    "\"$compiler\" /target:library /targetframework:net10.0 /out:\"$dllPath\" \"$gsPath\""
                )
                Assert.True(exitCode == 0, "gsc must compile the translated snippet. Output:\n" + output + `

Translated G#:
` + printed)
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("failed to start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }

        private func Translate(source string, outputKind OutputKind = OutputKind.DynamicallyLinkedLibrary) string {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Snippet",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(outputKind).WithNullableContextOptions(NullableContextOptions.Enable)
            )
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }
    }
}
