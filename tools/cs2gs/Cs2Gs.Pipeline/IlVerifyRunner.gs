// <copyright file="IlVerifyRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import GSharp.Tests
import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Text.RegularExpressions
import SystemObject = System.Object

/// Resolves and invokes the repo-pinned `dotnet-ilverify` local tool for
/// stage 3 (ADR-0115 §C). The recipe mirrors the repo's reference wrapper
/// `test/Compiler.Tests/IlVerifier.cs`: invoke `dotnet tool run
/// ilverify` with the process working directory anchored at the repo root so
/// the `.config/dotnet-tools.json` manifest is discovered, pass every
/// path absolute, and add the host runtime BCL plus the app's references and
/// output-local dependency assemblies to the verifier's reference set. All
/// process I/O is local — it only shells out to `dotnet`; there is no
/// network egress and no keys.
open class IlVerifyRunner {
    /// Initializes a new instance of the (cref:IlVerifyRunner) class.
    /// @param repoRoot The repository root (the directory containing
    /// `.config/dotnet-tools.json`). When `null` it is
    /// discovered by walking up from this assembly's location.
    init(repoRoot string? = nil) {
        this.RepoRoot = repoRoot ?? FindRepoRoot()
    }

    /// Gets the resolved repository root used as the tool working directory.
    prop RepoRoot string? {
        get;
    }

    /// Verifies the IL of the assembly at [`assemblyPath`](paramref) with
    /// the repo-pinned `dotnet-ilverify`, honoring the
    /// (cref:SkipEnvVar) bypass. The host runtime BCL is always added to
    /// the reference set; sibling-project and package assemblies copied beside
    /// the output are preferred, then [`additionalReferences`](paramref)
    /// (the corpus app's compile-time references) are appended. The
    /// (cref:KnownIlVerifyFalsePositives) codes are passed as ignore
    /// flags and filtered from the parsed errors, and the offset-exact #4489
    /// filter-in-finally rule is applied ((cref:FilterKnownFalsePositives)).
    /// @param assemblyPath The absolute path of the .dll to verify.
    /// @param additionalReferences The app's extra references, or null.
    /// @returns The verification result and parsed/recovered errors.
    open func Verify(assemblyPath string?, additionalReferences IReadOnlyList[string]? = nil) IlVerifyResult {
        if !IsEnabled {
            return IlVerifyResult.Skipped()
        }
        if string.IsNullOrEmpty(assemblyPath) || !File.Exists(assemblyPath) {
            return IlVerifyResult.Skipped()
        }
        this.EnsureToolAvailable()
        let references = BuildReferenceSet(assemblyPath, additionalReferences)
        let args = List[string]{"tool", "run", "ilverify", assemblyPath!!, "-s", "System.Private.CoreLib", "--verbose"}
        for reference in references {
            args.Add("-r")
            args.Add(reference)
        }
        for code in KnownIlVerifyFalsePositives {
            // ilverify's `-g` regex matches the bare error-category name.
            args.Add("-g")
            args.Add(code)
        }
        var (exit, output) = this.RunDotnet(args)
        let initialExit = exit
        let outputs = List[string]{output}
        // The #4489 rule reads every method body, so load it only once a
        // parsed StackUnderflow needs it; a clean run skips that pass.
        var filterInFinallyRule IlVerifyFilterInFinallyRule? = nil
        let FilterFalsePositives = func (parsed IEnumerable[IlVerifyError]) IReadOnlyList[IlVerifyError] {
            let kept = FilterIgnored(parsed).ToList()
            if !kept.Any((e IlVerifyError) -> string.Equals(e.Code, "StackUnderflow", StringComparison.Ordinal)) {
                return kept
            }
            filterInFinallyRule ??= IlVerifyFilterInFinallyRule.Load(assemblyPath)
            return FilterKnownFalsePositives(filterInFinallyRule, kept)
        }
        let errors = List[IlVerifyError](FilterFalsePositives(ParseErrors(output)))
        let excludedMembers = List[string]()
        // An unhandled ilverify exception exits with neither 0 (verified) nor
        // 2 (ordinary verification errors). Verbose mode identifies the member
        // being verified when it crashed. Exclude that member and retry until
        // the remaining assembly receives a complete pass/fail result.
        while exit != 0 && exit != 2 {
            let crashingMember string? = FindLastVerifyingMember(output)
            if string.IsNullOrEmpty(crashingMember) || excludedMembers.Contains(
                crashingMember!!,
                StringComparer.Ordinal
            ) {
                break
            }
            excludedMembers.Add(crashingMember!!)
            let retryArgs = List[string](args)
            for member in excludedMembers {
                retryArgs.Add("--exclude")
                retryArgs.Add("^" + Regex.Escape(member) + "$$")
            }
            exit, output = this.RunDotnet(retryArgs)
            outputs.Add(output)
            errors.AddRange(FilterFalsePositives(ParseErrors(output)))
        }
        let combinedOutput = CombineOutputs(outputs, excludedMembers)
        let distinctErrors IReadOnlyList[IlVerifyError] = errors
            .GroupBy((e IlVerifyError) -> (e.Code, e.Method, e.RawLine))
            .Select((group IGrouping[(Code string, Method string, RawLine string), IlVerifyError]) -> group.First())
            .ToList()
        let initialParsedErrors = ParseErrors(outputs[0])
        let initialErrors = FilterFalsePositives(initialParsedErrors)
        // Exit 2 with every finding filtered passes only when the parsed lines
        // account for ilverify's own "N Error(s)" count: a verifier error in a
        // shape ParseErrors does not recognize must never be silently dropped.
        if initialExit == 2 &&
            initialParsedErrors.Count > 0 &&
            initialErrors.Count == 0 &&
            ReadSummaryErrorCount(outputs[0]) == initialParsedErrors.Count {
            return IlVerifyResult.Passed(combinedOutput, distinctErrors)
        }
        if initialExit != 0 && initialExit != 2 {
            return IlVerifyResult.Incomplete(initialExit, combinedOutput, distinctErrors, excludedMembers)
        }
        return IlVerifyResult.FromRun(initialExit, combinedOutput, distinctErrors)
    }

    /// Probes/restores the repo local `dotnet-ilverify` tool once per
    /// process and repo root. The shared lock prevents parallel test hosts from
    /// racing on the same local tool manifest.
    /// @returns `true` when the tool is available after the probe/restore attempt.
    open func EnsureToolAvailable() bool {
        if !IsEnabled {
            return true
        }
        lock ToolRestoreSync {
            if ToolAvailabilityByRepoRoot.TryGetValue(this.RepoRoot!!, out var available) {
                return available
            }
            // `dotnet tool run ilverify --version` returns 0 when the manifest
            // tool is already restored. Only pay the restore cost when needed.
            let (probeExit, _) = this.RunDotnet([]string{"tool", "run", "ilverify", "--version"})
            available = probeExit == 0
            if !available {
                let (restoreExit, _) = this.RunDotnet([]string{"tool", "restore"})
                available = restoreExit == 0 && this.RunDotnet([]string{"tool", "run", "ilverify", "--version"})
                    .Exit == 0
            }
            ToolAvailabilityByRepoRoot[this.RepoRoot!!] = available
            return available
        }
    }

    /// Runs the repo-local dotnet tool command.
    /// @param arguments The dotnet arguments.
    /// @returns The process exit code and combined output.
    protected open func RunDotnet(arguments IReadOnlyList[string])(Exit int32, Output string) {
        // The local tool manifest is discovered relative to the working
        // directory; anchor at the repo root. All paths are passed absolute.
        let result = ProcessRunner.Run("dotnet", arguments, this.RepoRoot, DotnetToolTimeout)
        return (result.ExitCode, result.Output)
    }

    shared {
        /// The environment variable that, when set to `1`, bypasses IL
        /// verification (the stage no-ops to PASS). Intended for environments
        /// without the `dotnet-ilverify` tool; CI runs with verification on.
        /// Mirrors `IlVerifier`'s `GSHARP_SKIP_ILVERIFY` switch.
        const SkipEnvVar string = "GSHARP_SKIP_ILVERIFY"

        private const VerifyingPrefix string = "Verifying "

        // Matches a single ilverify error line, e.g.
        //   [IL]: Error [StackUnexpected]: [/abs/App.dll : Program::Main(string[])][offset 0x00000001] Unexpected type on the stack.
        // `code` is the bracketed ECMA-335 category; `location` (optional) carries
        // the `<assembly> : <Type>::<Method>(<sig>)` skeleton up to the `[offset …]`
        // marker (lazy so the `]` inside array types like `string[]` is not mistaken
        // for the location's closing bracket); `message` is the rest.
        private let ErrorPattern Regex = Regex(
            "^\\[IL\\]:\\s*Error\\s*\\[(?<code>[^\\]]+)\\]:\\s*" +
                "(?:\\[(?<location>.*?)\\]\\s*\\[offset[^\\]]*\\]\\s*)?(?<message>.*)$$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant
        )

        // ilverify's trailing summary, e.g. `2 Error(s) Verifying /abs/App.dll`.
        private let SummaryPattern Regex = Regex(
            "^(?<count>\\d+) Error\\(s\\) Verifying ",
            RegexOptions.Compiled | RegexOptions.CultureInvariant
        )

        private let AvaloniaXamlClosureBuildPattern Regex = Regex(
            "(?:^|\\+)XamlClosure_\\d+::Build_\\d+\\(\\[System\\.ComponentModel\\]System\\.IServiceProvider\\)$$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant
        )
        private let AvaloniaObjectSlotStackMismatchPattern Regex = Regex(
            "\\[found ref 'object'\\]\\[expected ref '[^'\\r\\n]+'\\] Unexpected type on the stack\\.$$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant
        )
        private let ToolRestoreSync object = SystemObject()
        private let ToolAvailabilityByRepoRoot Dictionary[string, bool] = Dictionary[string, bool](
            StringComparer.OrdinalIgnoreCase
        )
        private let DotnetToolTimeout TimeSpan = TimeSpan.FromMinutes(5)

        /// Gets the documented ilverify 10.0.8 FALSE-POSITIVE error codes the
        /// pipeline must ignore so it does not file spurious `ilverify-failure`
        /// gaps for known verifier limitations (NOT emitter bugs). These are passed
        /// to ilverify as `-g <code>` ignore-error flags and are also
        /// filtered defensively from any parsed output. Two upstream-tracked
        /// bundles, citing the same issues the repo's `IlVerifier` cites:
        /// - `ReturnPtrToStack` — by-value returns of a user-declared `ref struct` trip ilverify even when the
        /// value is in its only legal "permanent home" (the caller's frame). The same minimal C# (a
        /// `public ref struct` returned by value) compiled by `csc` emits identical IL and fails the same
        /// check. Track https://github.com/dotnet/runtime/issues/129030.
        /// - `CallAbstract` + `Constrained` — the static-virtual `constrained. !!T call` interface-dispatch
        /// pattern (ADR-0089 / issue #755) trips ilverify's pre-C#-11 rules; csc-emitted IL for the same C# 11
        /// pattern fails identically and the JIT accepts it. Track
        /// https://github.com/dotnet/runtime/issues/49558.
        private let _knownIlVerifyFalsePositives IReadOnlyList[string] = []string{
            "ReturnPtrToStack",
            "CallAbstract",
            "Constrained"
        }

        prop KnownIlVerifyFalsePositives IReadOnlyList[string] {
            get {
                return _knownIlVerifyFalsePositives
            }
        }

        /// Gets a value indicating whether IL verification is enabled for this run.
        /// Returns `false` when (cref:SkipEnvVar) is set to
        /// `1` (the stage then no-ops to PASS).
        prop IsEnabled bool -> Environment.GetEnvironmentVariable(SkipEnvVar) != "1"

        /// Parses every ilverify error line out of the tool's combined output. Lines
        /// that are not error records (banners, the trailing summary) are skipped.
        /// @param output The combined stdout+stderr of an ilverify run.
        /// @returns The parsed errors in tool order.
        func ParseErrors(output string) IReadOnlyList[IlVerifyError] {
            let errors = List[IlVerifyError]()
            if string.IsNullOrEmpty(output) {
                return errors
            }
            for rawLine in output.Replace("\r\n", "\n").Split('\n') {
                let line = rawLine.Trim()
                let match = ErrorPattern.Match(line)
                if !match.Success {
                    continue
                }
                let code = match.Groups["code"].Value.Trim()
                let method string? = ExtractMethod(match.Groups["location"].Value)
                errors.Add(IlVerifyError(code, method, line))
            }
            return errors
        }

        /// Removes the documented ilverify false-positive codes
        /// ((cref:KnownIlVerifyFalsePositives)) from a parsed error list, so
        /// the pipeline never files a spurious `ilverify-failure` gap for a
        /// known verifier limitation. This mirrors the `-g` ignore flags passed
        /// to ilverify and is applied defensively in case a tool build still surfaces
        /// the code.
        /// @param errors The parsed ilverify errors.
        /// @returns The errors with the known false positives removed.
        func FilterIgnored(errors IEnumerable[IlVerifyError]?) IReadOnlyList[IlVerifyError] {
            if errors == nil {
                return Array.Empty[IlVerifyError]()
            }
            let ignored = HashSet[string](KnownIlVerifyFalsePositives, StringComparer.OrdinalIgnoreCase)
            return errors.Where(
                (e IlVerifyError) -> (e.Code == nil || !ignored.Contains(e.Code)) &&
                    !IsAvaloniaXamlCompilerFalsePositive(e) &&
                    !IsAvaloniaXamlDelegateCtorFalsePositive(e)
            )
                .ToList()
        }

        /// Applies (cref:FilterIgnored) and then the assembly-aware #4489
        /// rule: ilverify 10.0.8 reports `StackUnderflow` at the first
        /// instruction of an exception filter whose start lies inside a
        /// `finally`/`fault` handler (upstream
        /// https://github.com/dotnet/runtime/issues/134711; Roslyn's IL for the same
        /// C# fails identically). This is NOT a category-wide ignore, which is why
        /// `StackUnderflow` is absent from (cref:KnownIlVerifyFalsePositives):
        /// only an error whose method and offset resolve, in the verified
        /// assembly's metadata, to exactly such a filter start is dropped. See
        /// `test/Shared/IlVerifyFilterInFinallyRule.cs`.
        /// @param filterInFinally The rule loaded for the verified assembly.
        /// @param errors The parsed ilverify errors.
        /// @returns The errors with every known false positive removed.
        internal func FilterKnownFalsePositives(
            filterInFinally IlVerifyFilterInFinallyRule?,
            errors IEnumerable[IlVerifyError]
        ) IReadOnlyList[IlVerifyError] -> FilterIgnored(errors).Where(
            (e IlVerifyError) -> !filterInFinally!!.Matches(e.Code, e.RawLine)
        )
            .ToList()

        private func ReadSummaryErrorCount(output string) int32? {
            for rawLine in(output ?? string.Empty).Replace("\r\n", "\n").Split('\n') {
                let match = SummaryPattern.Match(rawLine.Trim())
                if match.Success {
                    return int32.Parse(match.Groups["count"].Value, CultureInfo.InvariantCulture)
                }
            }
            return nil
        }

        private func ExtractMethod(location string) string? {
            if string.IsNullOrWhiteSpace(location) {
                return nil
            }
            // location is `<assembly path> : <Type>::<Method>(<sig>)`. Take the part
            // after the last " : " so a Windows drive colon does not split it.
            let sep = location.LastIndexOf(" : ", StringComparison.Ordinal)
            let candidate = if sep >= 0 {
                location.Substring(sep + 3).Trim()
            } else {
                location.Trim()
            }
            return if string.IsNullOrEmpty(candidate) {
                default(string?)
            } else {
                candidate
            }
        }

        private func FindLastVerifyingMember(output string) string? {
            var member string? = nil
            for rawLine in(output ?? string.Empty).Replace("\r\n", "\n").Split('\n') {
                let line = rawLine.Trim()
                if line.StartsWith(VerifyingPrefix, StringComparison.Ordinal) {
                    member = line.Substring(VerifyingPrefix.Length).Trim()
                }
            }
            return member
        }

        private func CombineOutputs(outputs IReadOnlyList[string], excludedMembers IReadOnlyList[string]) string {
            if outputs.Count == 1 {
                return outputs[0] ?? string.Empty
            }
            let sections = List[string]{
                "[IlVerifyRunner] Verification incomplete: ilverify crashed; recovering findings from non-crashing members."
            }
            for var i = 0; i < outputs.Count; i++ {
                let excluded = if i == 0 {
                    "<none>"
                } else {
                    string.Join(", ", excludedMembers.Take(i))
                }
                sections.Add(
                    "[IlVerifyRunner] Attempt " + (i + 1).ToString() +
                        "; excluded: " +
                        excluded +
                        Environment.NewLine +
                        (outputs[i] ?? string.Empty)
                )
            }
            return string.Join(Environment.NewLine, sections)
        }

        private func IsAvaloniaXamlCompilerFalsePositive(error IlVerifyError) bool {
            if !string.Equals(error.Code, "StackUnexpected", StringComparison.Ordinal) || string.IsNullOrEmpty(
                error.Method
            ) {
                return false
            }
            let generatedContextMethod = error.Method!!.StartsWith(
                "CompiledAvaloniaXaml.XamlIlContext+Context`1::",
                StringComparison.Ordinal
            )
            let generatedClosureObjectSlot = AvaloniaXamlClosureBuildPattern.IsMatch(error.Method!!) &&
                AvaloniaObjectSlotStackMismatchPattern.IsMatch(error.RawLine ?? string.Empty)
            return generatedContextMethod || generatedClosureObjectSlot
        }

        // Avalonia's XAML compiler binds static event handlers to RootObject. The
        // byte-identical C# output fails ilverify's DelegateCtor check as well.
        private func IsAvaloniaXamlDelegateCtorFalsePositive(error IlVerifyError) bool -> string.Equals(
            error.Code,
            "DelegateCtor",
            StringComparison.Ordinal
        ) &&
            error
            .Method
            ?.Contains("::!XamlIlPopulate(", StringComparison.Ordinal) == true

        private func BuildReferenceSet(assemblyPath string?, additionalReferences IReadOnlyList[string]?) IReadOnlyList[
            string
        ] {
            let seen = HashSet[string](StringComparer.OrdinalIgnoreCase)
            let ordered = List[string]()
            let fullAssembly = Path.GetFullPath(assemblyPath!!)
            let Add = func (path string) {
                if string.IsNullOrEmpty(path) {
                    return
                }
                // ilverify treats the verified assembly as the primary input; never
                // also pass it via -r (that confuses metadata loading).
                if string.Equals(Path.GetFullPath(path), fullAssembly, StringComparison.OrdinalIgnoreCase) {
                    return
                }
                if seen.Add(path) {
                    ordered.Add(path)
                }
            }
            for reference in BuildDefaultRuntimeReferences() {
                Add(reference)
            }
            let outputDirectory string? = Path.GetDirectoryName(fullAssembly)
            if !string.IsNullOrEmpty(outputDirectory) && Directory.Exists(outputDirectory) {
                for reference in Directory.EnumerateFiles(outputDirectory!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .OrderBy((path string) -> path, StringComparer.Ordinal) {
                    Add(reference)
                }
            }
            if additionalReferences != nil {
                // The build output contains the exact sibling/package implementation
                // assemblies the migrated app loads. Prefer them over source-project
                // ref assemblies or package-cache copies with the same identity.
                let preferredFileNames = HashSet[string](
                    ordered.Select(Path.GetFileName),
                    StringComparer.OrdinalIgnoreCase
                )
                for reference in additionalReferences {
                    if !string.IsNullOrEmpty(reference) && preferredFileNames.Contains(Path.GetFileName(reference)) {
                        continue
                    }
                    Add(reference)
                }
            }
            return ordered
        }

        private func BuildDefaultRuntimeReferences() IReadOnlyList[string] {
            // The host runtime directory is the stable source of BCL refs matching
            // what stage 2 passes to gsc, mirroring IlVerifier.BuildDefaultRuntimeReferences.
            let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                return Array.Empty[string]()
            }
            let refs = List[string]()
            for path in Directory.EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly) {
                let name = Path.GetFileName(path)
                if name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                    name,
                    "mscorlib.dll",
                    StringComparison.OrdinalIgnoreCase
                ) ||
                    string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase) || string.Equals(
                    name,
                    "Microsoft.CSharp.dll",
                    StringComparison.OrdinalIgnoreCase
                ) ||
                    string.Equals(name, "Microsoft.VisualBasic.Core.dll", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(name, "Microsoft.Win32.Primitives.dll", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(name, "Microsoft.Win32.Registry.dll", StringComparison.OrdinalIgnoreCase) {
                    refs.Add(path)
                }
            }
            return refs
        }

        private func FindRepoRoot() string? {
            // Walk up from this assembly's location until we find a directory holding
            // `.config/dotnet-tools.json`, so the local tool manifest is discovered
            // regardless of the runner's current directory (mirrors IlVerifier).
            var dir string? = Path.GetDirectoryName(typeof(IlVerifyRunner).Assembly.Location)
            while !string.IsNullOrEmpty(dir) {
                if File.Exists(Path.Combine(dir, ".config", "dotnet-tools.json")) {
                    return dir
                }
                dir = Path.GetDirectoryName(dir)
            }
            return Environment.CurrentDirectory
        }
    }
}

/// A single parsed `ilverify` error: its ECMA-335 category code, the
/// failing method skeleton (when present), and the trimmed raw line.
class IlVerifyError {
    /// Initializes a new instance of the (cref:IlVerifyError) class.
    /// @param code The ilverify error code (e.g. `StackUnexpected`).
    /// @param method The failing `Type::Method(sig)`, or null.
    /// @param rawLine The trimmed ilverify error line.
    init(code string, method string?, rawLine string) {
        this.Code = code
        this.Method = method
        this.RawLine = rawLine
    }

    /// Gets the ilverify error code (the ECMA-335 category).
    prop Code string? {
        get;
    }

    /// Gets the failing `Type::Method(sig)` skeleton, or null.
    prop Method string? {
        get;
    }

    /// Gets the trimmed ilverify error line.
    prop RawLine string {
        get;
    }
}

/// The outcome of an (cref:IlVerifyRunner.Verify) invocation.
class IlVerifyResult {
    private init(
        status IlVerifyStatus,
        exitCode int32,
        output string,
        errors IReadOnlyList[IlVerifyError],
        incompleteMembers IReadOnlyList[string]? = nil
    ) {
        this.Status = status
        this.ExitCode = exitCode
        this.Output = output
        this.Errors = errors ?? Array.Empty[IlVerifyError]()
        this.IncompleteMembers = incompleteMembers ?? Array.Empty[string]()
    }

    /// Gets the verification status.
    prop Status IlVerifyStatus {
        get;
    }

    /// Gets the ilverify process exit code (0 when skipped/passed).
    prop ExitCode int32 {
        get;
    }

    /// Gets the combined stdout+stderr (empty when skipped).
    prop Output string {
        get;
    }

    /// Gets the parsed, false-positive-filtered errors (empty on pass).
    prop Errors IReadOnlyList[IlVerifyError] {
        get;
    }

    /// Gets members excluded after they crashed ilverify.
    prop IncompleteMembers IReadOnlyList[string] {
        get;
    }

    /// Gets a value indicating whether the stage-3 gate held.
    prop Succeeded bool -> this.Status == IlVerifyStatus.Passed || this.Status == IlVerifyStatus.Skipped

    shared {
        /// Creates a skipped result (verification bypassed or no assembly).
        /// @returns A skipped (cref:IlVerifyResult).
        func Skipped() IlVerifyResult -> IlVerifyResult(
            IlVerifyStatus.Skipped,
            0,
            string.Empty,
            Array.Empty[IlVerifyError]()
        )

        /// Creates a passing result.
        /// @param output The tool output.
        /// @param errors The (empty, post-filter) error list.
        /// @returns A passing (cref:IlVerifyResult).
        func Passed(output string, errors IReadOnlyList[IlVerifyError]) IlVerifyResult -> IlVerifyResult(
            IlVerifyStatus.Passed,
            0,
            output,
            errors
        )

        /// Creates a failing result carrying the parsed errors.
        /// @param exitCode The ilverify exit code.
        /// @param output The tool output.
        /// @param errors The parsed, false-positive-filtered errors.
        /// @returns A failing (cref:IlVerifyResult).
        func Failed(
            exitCode int32,
            output string,
            errors IReadOnlyList[IlVerifyError]
        ) IlVerifyResult -> IlVerifyResult(IlVerifyStatus.Failed, exitCode, output, errors)

        /// Creates an incomplete result after an abnormal tool exit.
        /// @param exitCode The abnormal ilverify exit code.
        /// @param output The combined original and recovery output.
        /// @param errors Findings recovered from non-crashing members.
        /// @param incompleteMembers Members excluded because they crashed ilverify.
        /// @returns An incomplete (cref:IlVerifyResult).
        func Incomplete(
            exitCode int32,
            output string,
            errors IReadOnlyList[IlVerifyError],
            incompleteMembers IReadOnlyList[string]? = nil
        ) IlVerifyResult -> IlVerifyResult(IlVerifyStatus.Incomplete, exitCode, output, errors, incompleteMembers)

        /// Classifies a completed ilverify run (#1747/#2748): exit 0 is the
        /// only signal ilverify gives for "verified clean" — the `-g` ignore
        /// flags plus (cref:IlVerifyRunner.FilterIgnored) already strip known
        /// false positives before this runs, so a zero exit is trusted as-is. Exit
        /// 2 with parsed findings is an ordinary verifier failure. Every other
        /// non-zero result is incomplete: a tool crash / offline restore / future
        /// output-format change must never look like either a complete failure set
        /// or a pass.
        /// @param exitCode The ilverify process exit code.
        /// @param output The tool's combined stdout+stderr.
        /// @param errors The parsed, false-positive-filtered errors.
        /// @returns A passed, failed, or incomplete (cref:IlVerifyResult).
        func FromRun(exitCode int32, output string, errors IReadOnlyList[IlVerifyError]) IlVerifyResult {
            if exitCode == 0 {
                return Passed(output, errors)
            }
            return if exitCode == 2 && (errors != nil && errors.Count > 0) {
                Failed(exitCode, output, errors)
            } else {
                Incomplete(exitCode, output, errors)
            }
        }
    }
}
