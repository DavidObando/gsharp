// <copyright file="Issue3705LoadContextFunnelGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.IO
import System.Text.RegularExpressions
import Xunit

/// Issue #3705 (family 3), the load-context funnel's guard rail — the
/// companion to `Issue835TypeofIdentityRegressionGuardTests`, which
/// forbids `clrType == typeof(X)` for the same reason.
///
/// A host `typeof(X).IsAssignableFrom(candidate)` in the binder, lowerer
/// or emitter is unconditionally `false` whenever
/// [`candidate`](paramref) came from the compilation's
/// (cref:System.Reflection.MetadataLoadContext) — that is, on every
/// production `/reference:` compile. It never throws and never
/// diagnoses, so the wrong arm is simply taken: #3708 emitted no
/// `Dispose` for a `for` loop over an imported enumerable, and the
/// `typeof(Delegate)` arm of #3697 dropped every imported event-handler
/// candidate. New sites must ask
/// `GSharp.Core.CodeAnalysis.Symbols.ClrLoadContext.Satisfies` (well-known
/// target shape) or `ClrLoadContext.IsAssignable` (two arbitrary types).
open class Issue3705LoadContextFunnelGuardTests {
    /// Fails when a load-context-crossing assignability probe is hand-rolled
    /// instead of routed through the funnel.
    @Fact
    func No_Host_TypeofIsAssignableFrom_In_Binding_Lowering_Emit_Or_Symbols() {
        let offenders = List[string]()
        // Issue #4656: the tree's own language (C# before the cut-over, G#
        // after), and a scan that finds nothing fails instead of passing.
        for file in TestSource.SourceFiles(SearchOption.AllDirectories, ScannedRoots) {
            let relative = TestSource.RelativeStem(file)
            if AllowedFiles.ContainsKey(relative) {
                continue
            }
            let lines = File.ReadAllLines(file)
            for var i = 0; i < lines.Length; i++ {
                let code = StripCommentAndStrings(lines[i])
                if ForbiddenPattern.IsMatch(code) {
                    offenders.Add("$relative:${i + 1}: ${lines[i].Trim()}")
                }
            }
        }
        Assert.True(
            offenders.Count == 0,
            "Hand-rolled host `typeof(X).IsAssignableFrom(y)` is unconditionally false for a\n" +
                "MetadataLoadContext `y` (issue #3705, family 3). Use ClrLoadContext.Satisfies /\n" +
                "ClrLoadContext.IsAssignable, or add the file to AllowedFiles with a reason:\n  " +
                string.Join("\n  ", offenders)
        )
    }

    shared {
        /// Sites that legitimately compare against a well-known host type, with
        /// the reason. Kept as a set rather than an ordered, line-numbered list
        /// (which is what #835's guard uses) because these directories are edited
        /// concurrently; the assertion below only ever fails on an <em>unlisted</em>
        /// offender, so a stale entry cannot break an unrelated PR.
        private let AllowedFiles Dictionary[string, string] = Dictionary[string, string](StringComparer.Ordinal){
            [
                "src/Core/CodeAnalysis/Lowering/Lowerer"
            ] = "#3708 — enumerator disposal predicate, fixed under its own issue"
        }

        private let ScannedRoots[]string = []string{
            "src/Core/CodeAnalysis/Binding",
            "src/Core/CodeAnalysis/Lowering",
            "src/Core/CodeAnalysis/Emit",
            "src/Core/CodeAnalysis/Symbols"
        }

        // `typeof(...).IsAssignableFrom(...)`. The inner group forbids nested
        // parentheses so a `typeof(Foo<Bar>)` still matches (angle brackets are
        // not parentheses) while a method call is not mistaken for a typeof.
        private let ForbiddenPattern Regex = Regex(
            "typeof\\s*\\([^()]*\\)\\s*\\.\\s*IsAssignableFrom\\s*\\(",
            RegexOptions.Compiled
        )

        /// Removes line comments and string literals so the pattern only matches
        /// code position — doc comments describing the forbidden idiom (there are
        /// several, including on `ClrLoadContext` itself) must not trip it.
        /// @param line The source line.
        /// @returns The line with comment / literal text blanked out.
        private func StripCommentAndStrings(line string) string {
            let trimmed = line.TrimStart()
            if trimmed.StartsWith("//", StringComparison.Ordinal) || trimmed.StartsWith("*", StringComparison.Ordinal) {
                return string.Empty
            }
            let commentIndex = line.IndexOf("//", StringComparison.Ordinal)
            let code = if commentIndex >= 0 {
                line.Substring(0, commentIndex)
            } else {
                line
            }
            return Regex.Replace(code, "\"[^\"]*\"", "\"\"")
        }
    }
}
