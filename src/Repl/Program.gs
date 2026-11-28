// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl

import System
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Execution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.IO
import GSharp.Core.CodeAnalysis
import GSharp.Repl.Engine

/// Entry point for the G# TUI REPL.
shared class Program {
    func Main(args[]string) int32 {
        if args.Length == 0 {
            let envChoice = EngineChoiceFromEnvironment()
            if !IsValidEngineChoice(envChoice) {
                Console.Error.WriteLine(UnknownEngineMessage(envChoice))
                return 1
            }
            let envUi = UiChoiceFromEnvironment()
            if !TryParseUiChoice(envUi, out var defaultUi) {
                Console.Error.WriteLine(UnknownUiMessage(envUi))
                return 1
            }
            return RunInteractive(List[string](), defaultUi)
        }
        switch args[0] {
            case "--help", "-h", "/?" {
                Console.WriteLine(
                    "Usage: gsi [file.gs] [/r:<assembly> ...] [--ui <name>] [--engine <name>] [--help] [--version]"
                )
                Console.WriteLine("  file.gs                Run the given G# script and exit.")
                Console.WriteLine("  /r:<file>              Reference an assembly (repeatable).")
                Console.WriteLine("  /reference:<file>      Alias for /r: (also -r: and --reference:).")
                Console.WriteLine("  --ui <name>            Interactive UI: 'sharptui' (default) or 'spectre'")
                Console.WriteLine("                         (also via GSI_UI). Switch live with :ui.")
                Console.WriteLine("  --engine <name>        Interactive engine: 'emit' (the default and only")
                Console.WriteLine("                         engine; also via GSI_ENGINE). The legacy 'evaluator'")
                Console.WriteLine("                         engine has been removed.")
                Console.WriteLine("  --help, -h             Show this help and exit.")
                Console.WriteLine("  --version              Show the gsi version and exit.")
                Console.WriteLine("  (no args)              Start the interactive REPL.")
                return 0
            }
            case "--version" {
                Console.WriteLine(ReplHost.GetVersion())
                return 0
            }
        }
        let references = List[string]()
        var scriptPath string? = nil
        var engineChoice string? = nil
        var uiChoice string? = nil
        for var i = 0; i < args.Length; i++ {
            let arg = args[i]
            if TryParseReferenceSwitch(arg, out var referencePath) {
                references.Add(referencePath)
                continue
            }
            if arg == "--engine" && i + 1 < args.Length {
                engineChoice = args[(i += 1)]
                continue
            }
            if arg.StartsWith("--engine=", StringComparison.Ordinal) {
                engineChoice = arg.Substring("--engine=".Length)
                continue
            }
            if arg == "--ui" && i + 1 < args.Length {
                uiChoice = args[(i += 1)]
                continue
            }
            if arg.StartsWith("--ui=", StringComparison.Ordinal) {
                uiChoice = arg.Substring("--ui=".Length)
                continue
            }
            if scriptPath == nil && arg.EndsWith(".gs", StringComparison.OrdinalIgnoreCase) {
                scriptPath = arg
                continue
            }
            Console.Error.WriteLine("Unrecognized argument: $arg")
            return 1
        }
        engineChoice ??= EngineChoiceFromEnvironment()
        if !IsValidEngineChoice(engineChoice) {
            Console.Error.WriteLine(UnknownEngineMessage(engineChoice))
            return 1
        }
        uiChoice ??= UiChoiceFromEnvironment()
        if !TryParseUiChoice(uiChoice, out var selectedUi) {
            Console.Error.WriteLine(UnknownUiMessage(uiChoice))
            return 1
        }
        if !ReferenceResolver.TryValidateDriverReferencePaths(references, out var referenceError) {
            Console.Error.WriteLine(referenceError)
            return 1
        }
        if scriptPath == nil {
            return RunInteractive(references, selectedUi)
        }
        if !File.Exists(scriptPath) {
            Console.Error.WriteLine("File not found: $scriptPath")
            return 1
        }
        return RunScript(scriptPath, references)
    }

    /// Parses an interactive UI choice (`sharptui` default, or `spectre`).
    /// @param uiChoice The normalized UI choice, or `null` for the default.
    /// @param ui Receives the resolved UI backend when valid.
    /// @returns `true` when the choice is valid.
    internal func TryParseUiChoice(uiChoice string?, out ui ReplUiKind) bool {
        if string.IsNullOrEmpty(uiChoice) {
            ui = ReplUiKind.SharpTui
            return true
        }
        let normalized = uiChoice.Trim().ToLowerInvariant()
        if normalized == "sharptui" {
            ui = ReplUiKind.SharpTui
            return true
        }
        if normalized == "spectre" {
            ui = ReplUiKind.Spectre
            return true
        }
        ui = ReplUiKind.SharpTui
        return false
    }

    /// Builds the error line for an unknown UI choice, listing only valid values.
    /// @param uiChoice The rejected UI choice.
    /// @returns The error message.
    internal func UnknownUiMessage(
        uiChoice string?
    ) string -> "Unknown UI '$uiChoice'. Expected 'sharptui' or 'spectre'."

    /// Reads the `GSI_UI` environment variable as a normalized UI choice.
    /// @returns The lower-cased UI name, or `null` when unset or empty.
    internal func UiChoiceFromEnvironment() string? -> if Environment.GetEnvironmentVariable("GSI_UI") is {
        Length: > 0
    } env {
        env.ToLowerInvariant()
    } else {
        default(string?)
    }

    /// Decides whether an engine choice names a known interactive engine.
    /// ADR-0156 Phase 3c (#3176): the emitted submission-chaining engine is
    /// the only engine — the legacy tree-walking evaluator (and its
    /// `--engine evaluator` escape hatch) was deleted.
    /// @param engineChoice The normalized engine choice, or `null` for the default.
    /// @returns `true` when the choice is valid.
    internal func IsValidEngineChoice(engineChoice string?) bool -> engineChoice == nil || engineChoice == "emit"

    /// Builds the error line for an unknown engine choice, listing only valid values.
    /// @param engineChoice The rejected engine choice.
    /// @returns The error message.
    internal func UnknownEngineMessage(
        engineChoice string?
    ) string -> "Unknown engine '$engineChoice'. Expected 'emit'."

    /// Reads the `GSI_ENGINE` environment variable as a normalized engine choice.
    /// @returns The lower-cased engine name, or `null` when unset or empty.
    internal func EngineChoiceFromEnvironment() string? -> if Environment.GetEnvironmentVariable("GSI_ENGINE") is {
        Length: > 0
    } env {
        env.ToLowerInvariant()
    } else {
        default(string?)
    }

    /// ADR-0223 D4: gsi keeps the bundled runtime order of ADR-0207. The GSHARP_SDK_TOOLS_DIR folder
    /// comes before the folder beside gsi.
    /// @returns The folder, or `null` when the variable is not set.
    private func SdkToolsDirectory() string? -> Environment.GetEnvironmentVariable("GSHARP_SDK_TOOLS_DIR")

    /// Starts the interactive TUI on the emitted submission-chaining
    /// (cref:Engine.EmittedSessionEngine) (ADR-0156; the only
    /// interactive engine since Phase 3c deleted the tree-walking evaluator).
    private func RunInteractive(references List[string], uiKind ReplUiKind) int32 {
        if Console.IsInputRedirected || (uiKind == ReplUiKind.SharpTui && Console.IsOutputRedirected) {
            Console.Error.WriteLine("gsi requires an interactive terminal")
            return 1
        }
        let effectiveReferences = ReferenceResolver.ResolveDriverReferencePaths(references, SdkToolsDirectory())
        return ReplHost.Run(EmittedSessionEngine(effectiveReferences), uiKind)
    }

    /// ADR-0156 Phase 1: script execution compiles with the real emitter into
    /// memory and runs in-process via (cref:EmittedProgramHost) instead
    /// of the tree-walking evaluator. The driver protocol is unchanged:
    /// diagnostics render to standard error, the program's output streams
    /// straight through, and its integer result is the exit code.
    private func RunScript(scriptPath string, references List[string]) int32 {
        let tree = SyntaxTree.Load(scriptPath)
        let effectiveReferences = ReferenceResolver.ResolveDriverReferencePaths(references, SdkToolsDirectory())
        using let resolver = ReferenceResolver.WithRuntimeReferences(effectiveReferences)
        let compilation = Compilation(resolver, tree)
        var result EmittedProgramResult
        try {
            result = EmittedProgramHost.Run(compilation, effectiveReferences)
        } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
            return ReportUnhandledException(ex)
        }
        if result.Diagnostics.Any() {
            Console.Error.WriteDiagnostics(result.Diagnostics)
        }
        if !result.Success {
            return 1
        }
        if result.UnhandledException != nil {
            // Mirror the CLR host's unhandled-exception protocol so gsi
            // and `dotnet exec` render crashes identically.
            Console.Error.WriteLine(EmittedProgramHost.FormatUnhandledException(result.UnhandledException!!))
            return EmittedProgramHost.UnhandledExceptionExitCode
        }
        return result.ExitCode
    }

    internal func ReportUnhandledException(ex Exception) int32 {
        Console.Error.WriteDiagnostics(
            []GSharp.Core.CodeAnalysis.Diagnostic{Compilation.CreateInternalErrorDiagnostic(ex)}
        )
        return 1
    }

    /// Parses gsc-style reference switches: `/r:<file>` or
    /// `/reference:<file>` (also accepted with a leading dash).
    private func TryParseReferenceSwitch(arg string, @NotNullWhen(true) out referencePath string?) bool {
        referencePath = nil
        if arg.Length < 2 || (arg[0] != '/' && arg[0] != '-') {
            return false
        }
        let body = arg.Substring(
            if arg.StartsWith("--", StringComparison.Ordinal) {
                2
            } else {
                1
            }
        )
        let separator = body.IndexOfAny([]char{':', '='})
        if separator <= 0 {
            return false
        }
        let name = body.Substring(0, separator)
        if !name.Equals("r", StringComparison.OrdinalIgnoreCase) && !name.Equals(
            "reference",
            StringComparison.OrdinalIgnoreCase
        ) {
            return false
        }
        referencePath = body.Substring(separator + 1)
        return true
    }
}
