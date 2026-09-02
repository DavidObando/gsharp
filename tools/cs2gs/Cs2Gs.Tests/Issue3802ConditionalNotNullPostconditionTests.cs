// <copyright file="Issue3802ConditionalNotNullPostconditionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3802: <c>Path.GetExtension</c>, <c>Path.GetFileName</c> and
/// <c>Path.ChangeExtension</c> are declared <c>string?</c> with
/// <c>[return: NotNullIfNotNull(nameof(path))]</c> — the result is non-null
/// whenever the named argument is. Both nullability judgements in the
/// translator ended in the same "consult the DECLARED annotation" fallback,
/// which cannot see a CONDITIONAL post-condition.
/// <para>
/// The cost was concrete: migrating
/// <c>tools/cs2gs/Cs2Gs.Pipeline/RepositoryMirror.DestinationRelativePaths</c>
/// produced <c>sequence[string?]</c> with <c>let extension string? =
/// Path.GetExtension(source)</c> and <c>extension!!.Equals(...)</c>, and the
/// <c>string?</c> element then flowed into a <c>Dictionary[string, string]</c>
/// index in <c>ValidateCollisions</c>, which gsc rightly rejected with
/// <c>GS0155</c> — the whole of the gate's 40/51 regression.
/// </para>
/// </summary>
public class Issue3802ConditionalNotNullPostconditionTests
{
    /// <summary>
    /// The migrated shape, reduced: the iterator element must stay
    /// <c>string</c>, the local must stay <c>string</c>, and the dictionary
    /// index that consumes them must bind.
    /// </summary>
    [Fact]
    public void ConditionalPostcondition_KeepsTheIteratorElementNonNullable()
    {
        string printed = Translate(@"
using System.Collections.Generic;
using System.IO;

namespace Demo
{
    public class Mirror
    {
        public static void ValidateCollisions(IEnumerable<string> files)
        {
            var destinations = new Dictionary<string, string>();
            foreach (string source in files)
            {
                foreach (string destination in DestinationRelativePaths(source))
                {
                    destinations[destination] = source;
                }
            }
        }

        private static IEnumerable<string> DestinationRelativePaths(string source)
        {
            string extension = Path.GetExtension(source);
            if (extension.Equals("".cs""))
            {
                yield return Path.ChangeExtension(source, "".gs"");
                yield break;
            }

            yield return source;
        }
    }
}");

        Assert.Contains("sequence[string]", printed);
        Assert.DoesNotContain("sequence[string?]", printed);
        Assert.DoesNotContain("extension string?", printed);
        Assert.DoesNotContain("extension!!", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    /// <summary>
    /// CONDITIONAL GUARD: the post-condition is conditional, so a NULLABLE
    /// argument must still promote the result. A translator that narrowed
    /// unconditionally would emit a <c>string</c> declaration for a value that
    /// really can be nil and hide the nullability the migration exists to
    /// surface.
    /// </summary>
    [Fact]
    public void NullableArgument_StillPromotesTheResult()
    {
        string printed = Translate(@"
using System.IO;

namespace Demo
{
    public class Mirror
    {
        public static string Extension(string? source)
        {
            string extension = Path.GetExtension(source);
            return extension;
        }
    }
}");

        Assert.Contains("string?", printed);
    }

    /// <summary>
    /// The post-condition FORWARDS, it does not decide. When the named
    /// argument's own declaration is promoted to <c>T?</c> by the whole-program
    /// taint fixpoint, the call's result must be promoted with it — gsc will
    /// not narrow a call whose argument it sees as <c>T?</c>, so answering from
    /// the argument's C# syntax alone makes the two layers disagree.
    /// <para>
    /// This is the shape that broke the pinned Oahu corpus (9 of 15 apps, one
    /// fingerprint) on the first draft of this fix:
    /// <c>Oahu.Core/ExtensionsVarious.GetDownloadFileNameWithoutExtension</c>
    /// came out as <c>func (downloadFileName string?) ... string</c> — a
    /// <c>string?</c> argument feeding a <c>string</c> return.
    /// </para>
    /// </summary>
    [Fact]
    public void PromotedArgument_ForwardsItsNullabilityToTheResult()
    {
        string printed = Translate(@"
using System.IO;

namespace Demo
{
    public class Downloads
    {
        public static string NameWithoutExtension(string downloadFileName)
        {
            Report(downloadFileName == null);
            return Path.GetFileNameWithoutExtension(downloadFileName);
        }

        private static void Report(bool missing)
        {
        }
    }
}");

        // The `== null` promotes the PARAMETER; the return carries no direct
        // null at all, so it can only be promoted by the forwarding edge.
        Assert.Contains("downloadFileName string?", printed);
        Assert.Contains("string? {", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    /// <summary>
    /// ANTI-VACUITY: an UNANNOTATED nullable-returning member on the same type
    /// must still promote. <c>Path.GetDirectoryName</c> carries no
    /// <c>[NotNullIfNotNull]</c> (it returns null for a root path even with a
    /// non-null argument), so the fix must key off the attribute, not the type.
    /// </summary>
    [Fact]
    public void UnannotatedNullableReturn_StillPromotes()
    {
        string printed = Translate(@"
using System.IO;

namespace Demo
{
    public class Mirror
    {
        public static string Directory(string source)
        {
            string directory = Path.GetDirectoryName(source);
            return directory;
        }
    }
}");

        Assert.Contains("string?", printed);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Mirror.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics));

        LoadedDocument document = project.Documents[0];
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
