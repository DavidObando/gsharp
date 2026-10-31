// <copyright file="Issue5520StaticInitializerAccessNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System.Linq
import Xunit

/// Issue #5520: ADR-0208 rows R11 and R15 count a static field, property or event access of a type with a
/// non-literal `shared` field initializer (or a static constructor) as a call, because the type initializer runs
/// at the first access. gsc removes member-path and by-reference facts there, as it does at a call. C# flow
/// analysis keeps the fact, so the translated read needs its own `!!`. The translator answers with the one
/// decision `NodeRunsStaticTypeInitializer`; each test names the change that would make it fail.
open class Issue5520StaticInitializerAccessNarrowingTests {
    /// Mutation witness: `NodeRunsStaticTypeInitializer` returns false, or `IsByReferenceVariable` does.
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
    }

    /// The member-path shape of the LambdaBinder site (`node.Expression` guarded, then `kind == Kind.Void`, then the
    /// read). The translator already asserts a member path guarded in an earlier statement
    /// (`IsNullGuardNarrowedFieldUse`), so the static access needs no rule of its own; this row pins the result.
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
    }

    /// Mutation witness: the literal test counts a literal as code.
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
    }

    /// Mutation witness: a constant counts as an access.
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
    }

    /// Mutation witness: a construction or an instance member counts as a static access.
    @Fact
    func OutParameter_ReadAfterAConstructionAndAnInstanceMember_StaysBare() {
        let printed = Translate(`
public sealed class Mixed
{
    public int Id = 1;
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
    }

    /// Mutation witness: a plain local that no closure assigns is treated like a by-reference variable.
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
    }

    /// Mutation witness: a static access inside a function literal that is not run counts as an access.
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
    }

    /// Mutation witness: the owner test accepts a type of another compilation, or the declaring type is replaced by
    /// the receiver type of the access.
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
    }

    shared {
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
