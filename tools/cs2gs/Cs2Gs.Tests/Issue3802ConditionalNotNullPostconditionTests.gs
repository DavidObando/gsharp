// <copyright file="Issue3802ConditionalNotNullPostconditionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Xunit

/// Issue #3802: `Path.GetExtension`, `Path.GetFileName` and
/// `Path.ChangeExtension` are declared `string?` with
/// `[return: NotNullIfNotNull(nameof(path))]` — the result is non-null
/// whenever the named argument is. Both nullability judgements in the
/// translator ended in the same "consult the DECLARED annotation" fallback,
/// which cannot see a CONDITIONAL post-condition.
///
/// The cost was concrete: migrating
/// `tools/cs2gs/Cs2Gs.Pipeline/RepositoryMirror.DestinationRelativePaths`
/// produced `sequence[string?]` with `let extension string? =
/// Path.GetExtension(source)` and `extension!!.Equals(...)`, and the
/// `string?` element then flowed into a `Dictionary[string, string]`
/// index in `ValidateCollisions`, which gsc rightly rejected with
/// `GS0155` — the whole of the gate's 40/51 regression.
open class Issue3802ConditionalNotNullPostconditionTests {
    /// Issue #4071: a symbol resolver is allowed to miss. The null must reach
    /// the helper so its pattern check can reject the candidate; asserting at
    /// the callback boundary crashes before that check.
    @Fact
    func MissingInvocationSymbol_DoesNotCrashPostconditionAnalysis() {
        let printed = Translate(`
namespace Demo
{
    public class Probe
    {
        public static string Run(string @select)
        {
            return nameof(@select);
        }
    }
}`)
        Assert.Contains("\"select\"", printed)
    }

    /// The migrated shape, reduced: the iterator element must stay
    /// `string`, the local must stay `string`, and the dictionary
    /// index that consumes them must bind.
    @Fact
    func ConditionalPostcondition_KeepsTheIteratorElementNonNullable() {
        let printed = Translate(`
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
            if (extension.Equals(".cs"))
            {
                yield return Path.ChangeExtension(source, ".gs");
                yield break;
            }

            yield return source;
        }
    }
}`)
        Assert.Contains("sequence[string]", printed)
        Assert.DoesNotContain("sequence[string?]", printed)
        Assert.DoesNotContain("extension string?", printed)
        Assert.DoesNotContain("extension!!", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    /// CONDITIONAL GUARD: the post-condition is conditional, so a NULLABLE
    /// argument must still promote the result. A translator that narrowed
    /// unconditionally would emit a `string` declaration for a value that
    /// really can be nil and hide the nullability the migration exists to
    /// surface.
    @Fact
    func NullableArgument_StillPromotesTheResult() {
        let printed = Translate(`
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
}`)
        Assert.Contains("string?", printed)
    }

    /// The post-condition FORWARDS, it does not decide. When the named
    /// argument's own declaration is promoted to `T?` by the whole-program
    /// taint fixpoint, the call's result must be promoted with it — gsc will
    /// not narrow a call whose argument it sees as `T?`, so answering from
    /// the argument's C# syntax alone makes the two layers disagree.
    ///
    /// This is the shape that broke the pinned Oahu corpus (9 of 15 apps, one
    /// fingerprint) on the first draft of this fix:
    /// `Oahu.Core/ExtensionsVarious.GetDownloadFileNameWithoutExtension`
    /// came out as `func (downloadFileName string?) ... string` — a
    /// `string?` argument feeding a `string` return.
    @Fact
    func PromotedArgument_ForwardsItsNullabilityToTheResult() {
        let printed = Translate(`
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
}`)
        // The `== null` promotes the PARAMETER; the return carries no direct
        // null at all, so it can only be promoted by the forwarding edge.
        Assert.Contains("downloadFileName string?", printed)
        Assert.Contains("string? {", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    /// ANTI-VACUITY: an UNANNOTATED nullable-returning member on the same type
    /// must still promote. `Path.GetDirectoryName` carries no
    /// `[NotNullIfNotNull]` (it returns null for a root path even with a
    /// non-null argument), so the fix must key off the attribute, not the type.
    @Fact
    func UnannotatedNullableReturn_StillPromotes() {
        let printed = Translate(`
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
}`)
        Assert.Contains("string?", printed)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Mirror.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics)
            )
            let document = project.Documents[0]
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
