// <copyright file="Issue3718TypeRefScopeFunnelGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.IO
import System.Text.RegularExpressions
import Xunit

/// Issue #3718, the TypeRef-resolution-scope funnel's guard rail — the sibling
/// of `Issue3705LoadContextFunnelGuardTests`. That one forbids
/// <em>comparing</em> against a live host `typeof`; this one keeps the
/// compiler from <em>emitting</em> one.
///
/// A compiler-internal `typeof(X)` yields a runtime (cref:Type)
/// whose assembly is whichever corlib hosts gsc. Turning that type into a
/// `TypeRef` row scoped to `type.Assembly` writes an
/// `AssemblyRef` to `System.Private.CoreLib` into an assembly whose
/// reference closure only ever named the targeting pack — 65 of the 128
/// conformance samples did exactly that before #3718. The defect is invisible
/// to an IL comparison (the opcode stream is unchanged) and to the build (the
/// row is well-formed), so the only durable protection is structural: exactly
/// one place in the compiler may write a `TypeRef` or an
/// `AssemblyRef`, and that place projects the type onto the compilation's
/// reference closure first.
open class Issue3718TypeRefScopeFunnelGuardTests {
    /// Fails when a `TypeRef` or `AssemblyRef` row is written
    /// anywhere but the funnel.
    @Fact
    func No_TypeRef_Or_AssemblyRef_Rows_Outside_The_Funnel() {
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
            "A TypeRef / AssemblyRef row is written outside ImportedMemberRefFactory (issue #3718).\n" +
                "Rows created elsewhere skip the projection of host `typeof` types onto the\n" +
                "compilation's reference closure, which leaks a System.Private.CoreLib AssemblyRef\n" +
                "into ref-pack builds. Route through ImportedMemberRefFactory.GetTypeReference, or\n" +
                "add the file to AllowedFiles with a reason:\n  " +
                string.Join("\n  ", offenders)
        )
    }

    /// The funnel must keep doing the projection: a rewrite that drops the
    /// call turns this whole guard into a no-op that still passes.
    @Fact
    func The_Funnel_Still_Projects_Onto_The_Reference_Closure() {
        let funnel = TestSource.SourcePath("src/Core/CodeAnalysis/Emit/ImportedMemberRefFactory")
        Assert.True(File.Exists(funnel), "the funnel moved: $funnel does not exist")
        let text = File.ReadAllText(funnel)
        Assert.Contains("TryProjectOntoReferences", text, StringComparison.Ordinal)
        Assert.Contains("TryResolveType", text, StringComparison.Ordinal)
    }

    shared {
        /// The sole sanctioned producer of `TypeRef` / `AssemblyRef`
        /// rows: `ImportedMemberRefFactory.GetTypeReference(Type)` projects a
        /// host type onto `EmitContext.References` before choosing the row's
        /// resolution scope, and `GetAssemblyReference` is reached only from
        /// there. A second producer would bypass the projection.
        private let AllowedFiles Dictionary[string, string] = Dictionary[string, string](StringComparer.Ordinal){
            [
                "src/Core/CodeAnalysis/Emit/ImportedMemberRefFactory"
            ] = "#3718 — the funnel itself: projects host types onto the reference closure before scoping the row"
        }

        private let ScannedRoots[]string = []string{
            "src/Core/CodeAnalysis/Binding",
            "src/Core/CodeAnalysis/Lowering",
            "src/Core/CodeAnalysis/Emit",
            "src/Core/CodeAnalysis/Symbols"
        }
        private let ForbiddenPattern Regex = Regex("\\.\\s*Add(Type|Assembly)Reference\\s*\\(", RegexOptions.Compiled)

        /// Removes line comments and string literals so the pattern only matches
        /// code position — doc comments naming the forbidden idiom (there are
        /// several) must not trip it.
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
