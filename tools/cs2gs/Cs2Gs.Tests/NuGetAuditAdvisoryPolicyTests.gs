// <copyright file="NuGetAuditAdvisoryPolicyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Translator.Loading
import Xunit

/// Pure policy tests for issue #2321: (cref:NuGetAuditAdvisoryPolicy)
/// must recognize ONLY the stable NU1901-NU1904 NuGet audit vulnerability
/// advisory shape as benign, and must keep every other
/// (cref:Microsoft.CodeAnalysis.WorkspaceDiagnosticKind.Failure) message
/// — including NU1900, genuine MSBuild workspace load failures, and any
/// mixed/multiline message with a non-advisory line — fatal. Message shapes in
/// the "benign" cases are the verbatim text captured from a real
/// `MSBuildWorkspace.Diagnostics` entry while investigating #2321 (a
/// project referencing `Newtonsoft.Json 12.0.1`, which carries the known
/// high-severity advisory GHSA-5crp-9r3c-p9vr); the NU1900 shapes are the
/// examples from
/// https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1900.
open class NuGetAuditAdvisoryPolicyTests {
    @Theory
    @InlineData(
        "Package 'SQLitePCLRaw.lib.e_sqlite3' 2.1.11 has a known high severity vulnerability, https://github.com/advisories/GHSA-example"
    )
    @InlineData(
        "Package 'Contoso.Utilities' 1.0.0 has a known low severity vulnerability, https://cve.contoso.com/advisories/1"
    )
    @InlineData(
        "Package 'Contoso.Utilities' 1.0.0 has a known moderate severity vulnerability, https://cve.contoso.com/advisories/1"
    )
    @InlineData(
        "Package 'Contoso.Utilities' 1.0.0 has a known critical severity vulnerability, https://cve.contoso.com/advisories/1"
    )
    @InlineData(
        "PACKAGE 'Contoso.Utilities' 1.0.0 HAS A KNOWN HIGH SEVERITY VULNERABILITY, https://cve.contoso.com/advisories/1"
    )
    func IsBenignAdvisory_BareNU190xShape_IsBenign(message string) {
        Assert.True(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_RealWorkspaceWrappedMessage_IsBenign() {
        // Verbatim shape observed from workspace.Diagnostics when
        // MSBuildWorkspace opens a project referencing a vulnerable package
        // (Newtonsoft.Json 12.0.1, NU1903/high, GHSA-5crp-9r3c-p9vr).
        const message = "Msbuild failed when processing the file '/repo/App/App.csproj' with message: " +
            "Package 'Newtonsoft.Json' 12.0.1 has a known high severity vulnerability, " +
            "https://github.com/advisories/GHSA-5crp-9r3c-p9vr"
        Assert.True(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_RealWorkspaceWrappedMessage_WarningAsError_IsBenign() {
        // Verbatim shape observed when the SDK's audit warnings are elevated by
        // <TreatWarningsAsErrors> (as this repo's own build props do): MSBuild
        // prepends a literal "Warning As Error: " marker ahead of the advisory
        // text, but the underlying advisory is exactly as benign.
        const message = "Msbuild failed when processing the file '/repo/App/App.csproj' with message: " +
            "Warning As Error: Package 'Newtonsoft.Json' 12.0.1 has a known high severity vulnerability, " +
            "https://github.com/advisories/GHSA-5crp-9r3c-p9vr"
        Assert.True(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_MultipleAdvisoryLines_AllBenign_IsBenign() {
        const message = "Package 'A' 1.0.0 has a known high severity vulnerability, https://example.com/a\n" +
            "Package 'B' 2.0.0 has a known low severity vulnerability, https://example.com/b"
        Assert.True(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Theory
    @InlineData(nil)
    @InlineData("")
    @InlineData("   ")
    func IsBenignAdvisory_NullOrBlank_IsNotBenign(message string?) {
        Assert.False(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_NU1900_AuditSourceUnavailable_IsNotBenign() {
        // NU1900 Example 1 (https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1900):
        // the audit source itself could not be reached — must remain fatal so
        // migrations do not silently proceed on stale/missing vulnerability data.
        const message = "warning NU1900: Error occurred while getting package vulnerability data: (more information)"
        Assert.False(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_NU1900_UnknownSeverity_IsNotBenign() {
        // NU1900 Example 2: same "Package ... has a known ... severity
        // vulnerability, <url>" sentence shape as NU1901-NU1904, but with an
        // out-of-band "unknown" severity — the source returned invalid data,
        // which is a real audit failure, not a benign advisory.
        const message = "Package 'Contoso.Utilities' 1.0.0 has a known unknown severity vulnerability, https://cve.contoso.com/advisories/1"
        Assert.False(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_MissingProjectReference_IsNotBenign() {
        // Verbatim shape observed from workspace.Diagnostics for an
        // unresolvable <ProjectReference> (issue #1742's original scenario).
        const message = "Msbuild failed when processing the file '/repo/App/App.csproj' with message: " +
            "The referenced project ../DoesNotExist/DoesNotExist.csproj does not exist."
        Assert.False(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_ProjectFileNotFound_IsNotBenign() {
        const message = "Project file not found: '/repo/DoesNotExist/DoesNotExist.csproj'"
        Assert.False(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_UnsupportedTargetFramework_IsNotBenign() {
        const message = "Msbuild failed when processing the file '/repo/App/App.csproj' with message: " +
            "The current .NET SDK does not support targeting .NET Silly 1.0. Either target .NET 8.0 or lower, " +
            "or use a version of the .NET SDK that supports .NET Silly 1.0."
        Assert.False(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_MissingSdkImport_IsNotBenign() {
        const message = "Msbuild failed when processing the file '/repo/App/App.csproj' with message: " +
            "The imported project \"/usr/share/dotnet/sdk/Missing.Sdk/Sdk.props\" was not found."
        Assert.False(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_MixedMultilineMessage_WithNonAdvisorySegment_IsNotBenign() {
        // One genuinely benign advisory line plus one real-failure line: the
        // whole diagnostic must remain fatal because it carries a non-advisory
        // segment (issue #2321 explicitly requires this).
        const message = "Package 'A' 1.0.0 has a known high severity vulnerability, https://example.com/a\n" +
            "The referenced project ../DoesNotExist/DoesNotExist.csproj does not exist."
        Assert.False(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_AdvisoryLineWithTrailingExtraText_IsNotBenign() {
        // Extra content appended after the advisory URL on the SAME line is a
        // non-advisory segment sharing the line — must not match.
        const message = "Package 'A' 1.0.0 has a known high severity vulnerability, https://example.com/a and also something else broke"
        Assert.False(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }

    @Fact
    func IsBenignAdvisory_AdvisoryLineWithLeadingExtraText_IsNotBenign() {
        // Arbitrary free-form text ahead of the advisory sentence (not the
        // recognized MSBuildWorkspace wrapper or "Warning As Error:" marker)
        // must not be silently swallowed by a permissive prefix match.
        const message = "Something else failed first. Package 'A' 1.0.0 has a known high severity vulnerability, https://example.com/a"
        Assert.False(NuGetAuditAdvisoryPolicy.IsBenignAdvisory(message))
    }
}
