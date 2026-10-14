// <copyright file="Issue2941FlagsEnumExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis

/// Issue #2941: flags annotations do not change enum exhaustiveness, and
/// switch-expression diagnostics remain mutually exclusive.
open class Issue2941FlagsEnumExhaustivenessTests {
    @Theory
    @MemberData("MatrixCases")
    func EnumExhaustivenessMatrix_ReportsExactDiagnosticsAndReturnFlow(
        origin EnumOrigin,
        form SwitchForm,
        shape SwitchShape
    ) {
        let source = BuildSource(origin, form, shape)
        let tree = SyntaxTree.Parse(SourceText.From(source, "$origin-$form-$shape.gs"))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        let diagnostics = result
            .Diagnostics
            .OrderBy((diagnostic Diagnostic) -> diagnostic.Location.Span.Start)
            .ThenBy((diagnostic Diagnostic) -> diagnostic.Id, StringComparer.Ordinal)
            .ToArray()
        let expected = ExpectedDiagnostics(form, shape)
        Assert.Equal(expected.Length, diagnostics.Length)
        for var i = 0; i < expected.Length; i++ {
            Assert.Equal(expected[i].Id, diagnostics[i].Id)
            Assert.Equal(
                expected[i].LocationText,
                diagnostics[i].Location.Text!!.ToString(diagnostics[i].Location.Span)
            )
        }
        Assert.Equal(shape != SwitchShape.Incomplete, result.Success)
        Assert.Equal(shape != SwitchShape.Incomplete, peStream.Length > int64(0))
        if form == SwitchForm.Statement {
            Assert.Equal(
                if shape == SwitchShape.Incomplete {
                    1
                } else {
                    0
                },
                diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0100")
            )
        } else {
            Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0100")
        }
    }

    @Fact
    func IncompleteEnumSwitchExpression_ReportsOneDiagnosticAtSwitch() {
        let source = BuildSource(EnumOrigin.ImportedFlags, SwitchForm.Expression, SwitchShape.Incomplete)
        let tree = SyntaxTree.Parse(SourceText.From(source, "single-diagnostic.gs"))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0177", diagnostic.Id)
        Assert.Equal("switch", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func LiveDiagnosticDocs_StateNamedConstantFlagsRule() {
        let repoRoot string? = FindRepoRoot()
        for relativePath in[]string{"docs/diagnostics.md", "website/docs/ref/diagnostics.md"} {
            let text = File.ReadAllText(Path.Combine(repoRoot!!, relativePath))
            Assert.Contains(ExhaustivenessRule, text, StringComparison.Ordinal)
            Assert.Contains(FlagsRule, text, StringComparison.Ordinal)
            Assert.Contains(OriginRule, text, StringComparison.Ordinal)
        }
    }

    enum EnumOrigin {
        ImportedFlags,
        UserFlags,
        PlainEnum
    }

    enum SwitchForm {
        Statement,
        Expression
    }

    enum SwitchShape {
        NameComplete,
        Incomplete,
        HasDefault,
        DuplicateArm
    }

    shared {
        private const ExhaustivenessRule string = "Enum switches cover named constants only."
        private const FlagsRule string = "`[Flags]` does not add unnamed bit combinations as required switch arms."
        private const OriginRule string = "This rule is identical for imported CLR enums and source-declared enums."

        /// Gets every enum-origin, switch-form, and coverage-shape combination.
        func MatrixCases() sequence[[]object] {
            for origin in Enum.GetValues[EnumOrigin]() {
                for form in Enum.GetValues[SwitchForm]() {
                    for shape in Enum.GetValues[SwitchShape]() {
                        yield[]object{origin, form, shape}
                    }
                }
            }
        }

        private func ExpectedDiagnostics(form SwitchForm, shape SwitchShape)[](Id string, LocationText string) {
            if shape != SwitchShape.Incomplete {
                return Array.Empty[(string, string)]()
            }
            return if form == SwitchForm.Statement {
                [](string, string){("GS0100", "F"), ("GS0178", "switch")}
            } else {
                [](string, string){("GS0177", "switch")}
            }
        }

        private func BuildSource(origin EnumOrigin, form SwitchForm, shape SwitchShape) string {
            let (declaration, typeName, members) = switch origin {
                case EnumOrigin.ImportedFlags: (
                    "import System",
                    "StringSplitOptions",
                    []string{"None", "RemoveEmptyEntries", "TrimEntries"}
                )
                case EnumOrigin.UserFlags: (`import System
@Flags
enum Access { None = 0, Read = 1, Write = 2 }`, "Access", []string{"None", "Read", "Write"})
                default: ("enum Access { None, Read, Write }", "Access", []string{"None", "Read", "Write"})
            }
            let arms = BuildArms(typeName, members, form, shape)
            let function = if form == SwitchForm.Statement {
                (`func F(x ` + "$typeName" + `) int32 {
    switch x {
` + "$arms" + `    }
}`)
            } else {
                (`func F(x ` + "$typeName" + `) int32 {
    return switch x {
` + "$arms" + `    }
}`)
            }
            return (`package Issue2941.` + "$origin" + `.` + "$form" + `.` + "$shape" + `
` + "$declaration" + `
` + "$function" + `
`)
        }

        private func BuildArms(
            typeName string,
            members IReadOnlyList[string],
            form SwitchForm,
            shape SwitchShape
        ) string {
            let selected = if shape == SwitchShape.Incomplete || shape == SwitchShape.HasDefault {
                []string{members[0]}
            } else {
                members.ToArray()
            }
            let builder = StringBuilder()
            for var i = 0; i < selected.Length; i++ {
                AppendArm(builder, typeName, selected[i], i, form)
                if shape == SwitchShape.DuplicateArm && i == 0 {
                    AppendArm(builder, typeName, selected[i], 99, form)
                }
            }
            if shape == SwitchShape.HasDefault {
                builder.Append(
                    if form == SwitchForm.Statement {
                        "        default { return 9 }\n"
                    } else {
                        "        default: 9\n"
                    }
                )
            }
            return builder.ToString()
        }

        private func AppendArm(builder StringBuilder, typeName string, member string, value int32, form SwitchForm) {
            builder.Append(
                if form == SwitchForm.Statement {
                    (`        case ` + "$typeName" + `.` + "$member" + ` { return ` + "$value" + ` }
`)
                } else {
                    (`        case ` + "$typeName" + `.` + "$member" + `: ` + "$value" + `
`)
                }
            )
        }

        private func FindRepoRoot() string? {
            var directory string? = Path.GetDirectoryName(
                typeof(Issue2941FlagsEnumExhaustivenessTests).Assembly.Location
            )
            while !string.IsNullOrEmpty(directory) {
                if RepositoryRootMarker.IsRoot(directory) {
                    return directory
                }
                directory = Path.GetDirectoryName(directory)
            }
            return Environment.CurrentDirectory
        }
    }
}
