// <copyright file="NuGetAuditAdvisoryPolicy.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Loading

import System
import System.Text.RegularExpressions

/// Issue #2321: (cref:Microsoft.CodeAnalysis.MSBuild.MSBuildWorkspace)
/// records every warning-or-worse line MSBuild logs while opening a project as
/// a (cref:Microsoft.CodeAnalysis.WorkspaceDiagnosticKind.Failure) —
/// including the non-fatal NuGet audit vulnerability advisories NuGet emits as
/// warnings NU1901 (low), NU1902 (moderate), NU1903 (high), and NU1904
/// (critical) per
/// https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1901-nu1904.
/// A package flagged by one of those carries a known vulnerability but still
/// restores and builds; it must not make (cref:CSharpProjectLoader) gate
/// the project out with (cref:CSharpProjectLoader.WorkspaceLoadFailureDiagnosticId)
/// (CS2GS0001).
/// @remarks This policy recognizes ONLY that one stable advisory message shape as
/// benign. It intentionally does not match:
/// - NU1900 (a failure to even fetch vulnerability data, or a source that returned an out-of-band
/// severity value such as "unknown" — see
/// https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1900): these mean the audit itself
/// is unreliable, not that a benign advisory was found, and must stay fatal.
/// - Genuine MSBuild workspace load failures — missing SDK/imports, an unresolvable `ProjectReference`,
/// an unsupported target framework, etc.
/// - A mixed or multiline diagnostic message where any non-blank line is not itself an advisory: every
/// line must independently match, or the whole message is treated as fatal.
shared class NuGetAuditAdvisoryPolicy {
    // MSBuildWorkspace wraps each captured MSBuild diagnostic line as:
    //   Msbuild failed when processing the file '<path>' with message: <text>
    // (observed verbatim from Microsoft.CodeAnalysis.Workspaces.MSBuild). The
    // policy tolerates this wrapper, but also accepts the bare <text> so it
    // keeps working if a caller ever passes the inner message directly.
    private let WorkspaceWrapperPrefix Regex = Regex(
        "^Msbuild\\ failed\\ when\\ processing\\ the\\ file\\ '[^']*'\\ with\\ message:\\s*",
        RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnorePatternWhitespace
    )

    // When the SDK's audit warnings are elevated by <TreatWarningsAsErrors>,
    // MSBuild prepends this literal marker ahead of the advisory text (also
    // observed verbatim); it carries no independent failure information, so it
    // is stripped before the advisory-shape check.
    private let WarningAsErrorPrefix Regex = Regex(
        "^Warning\\ As\\ Error:\\s*",
        RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnorePatternWhitespace
    )

    // The stable NU1901-NU1904 advisory shape: "Package '<id>' <version> has a
    // known <low|moderate|high|critical> severity vulnerability, <url>". The
    // severity is deliberately restricted to those four literal words — NU1900
    // can report a server-supplied severity of "unknown" for the exact same
    // sentence shape, and that case must stay fatal (the audit source itself
    // returned bad data), not be treated as a benign advisory.
    private let AdvisoryCoreShape Regex = Regex(
        "^Package\\ '[^']+'\\ \\S+\\ has\\ a\\ known\\ (?:low|moderate|high|critical)\\ severity\\ vulnerability,\\ https?://\\S+$$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnorePatternWhitespace
    )

    /// Determines whether a (cref:Microsoft.CodeAnalysis.WorkspaceDiagnostic)
    /// message reported at (cref:Microsoft.CodeAnalysis.WorkspaceDiagnosticKind.Failure)
    /// is, in its entirety, one or more benign NuGet audit vulnerability
    /// advisories (the NU1901-NU1904 shape) and therefore must not be treated
    /// as a fatal project-load failure.
    /// @param message The raw `WorkspaceDiagnostic.Message` text.
    /// @returns `true` only if every non-blank line of
    /// [`message`](paramref) independently matches the advisory shape;
    /// `false` for a `null`/blank message, for
    /// any genuine workspace failure, and for a mixed/multiline message that
    /// carries even one non-advisory line.
    func IsBenignAdvisory(message string?) bool {
        if string.IsNullOrWhiteSpace(message) {
            return false
        }
        let lines = message.Split([]string{"\r\n", "\n", "\r"}, StringSplitOptions.None)
        var sawAdvisoryLine = false
        for rawLine in lines {
            var line = rawLine.Trim()
            if line.Length == 0 {
                continue
            }
            line = WorkspaceWrapperPrefix.Replace(line, string.Empty)
            line = WarningAsErrorPrefix.Replace(line, string.Empty).Trim()
            if !AdvisoryCoreShape.IsMatch(line) {
                return false
            }
            sawAdvisoryLine = true
        }
        return sawAdvisoryLine
    }
}
