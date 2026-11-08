// <copyright file="Issue5801StaticInitInterpolatedStringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #5801: interpolated strings inside `shared { init { ... } }` and
/// `shared class { init { ... } }` blocks must be lowered by
/// `InterpolatedStringHandlerLowerer` before emit, both when the type has no
/// `InitializationPlanner` plan and when it does.
open class Issue5801StaticInitInterpolatedStringTests {
    @Theory
    @MemberData("Probes")
    func StaticInitInterpolatedString_EmitsVerifiesAndRuns(name string, source string, expectedOutput string) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "issue5801-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(tempDir)
        try {
            let srcPath = Path.Combine(tempDir, name + ".gs")
            let outPath = Path.Combine(tempDir, name + ".dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            let log = compileOut.ToString() + compileErr.ToString()
            Assert.True(exitCode == 0, "${name}: expected exit 0. Log:\n${log}")
            Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal)
            Assert.True(File.Exists(outPath), "${name}: output assembly missing. Log:\n${log}")
            IlVerifier.Verify(outPath)
            let (runExit, stdout, stderr) = RunDotnet(outPath)
            Assert.True(runExit == 0, "${name}: runtime failed (${runExit}):\n${stderr}")
            let actual = string.Join(
                "|",
                stdout.Split('\n').Select((line string) -> line.TrimEnd('\r')).Where((line string) -> line.Length > 0)
            )
            Assert.Equal(expectedOutput, actual)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const RunTimeout int32 = 30000

        func Probes() IEnumerable[[]object] {
            yield []object{"class_shared_init_interpolated_string", `package Probe
import System

class K {
    shared {
        var S string = ""
        init {
            let n = 3
            S = "n=${n}"
        }
    }
}

Console.WriteLine(K.S)`, "n=3"}
            yield []object{"shared_class_init_formatted_and_custom_handler", `package Probe
import System
import System.Globalization
import System.Text

shared class Config {
    var Banner string = ""
    var BuilderText string = ""

    init {
        let version = 7
        let label = "gsc"
        Banner = String.Create(CultureInfo.InvariantCulture, "${label}-${version,3:000}")
        let sb = StringBuilder()
        sb.Append("v=${version}")
        BuilderText = sb.ToString()
    }
}

Console.WriteLine(Config.Banner)
Console.WriteLine(Config.BuilderText)`, "gsc-007|v=7"}
            yield []object{"static_init_with_captured_lambda_and_interpolation", `package Probe
import System

class WithPlan {
    shared {
        var Text string = ""
        init {
            var baseVal = 10
            let bump = () -> {
                baseVal += 5
            }
            bump()
            Text = "val=${baseVal}"
        }
    }
}

Console.WriteLine(WithPlan.Text)`, "val=15"}
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Stdout string, Stderr string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) { }
                return (-1, "", "timed out after ${RunTimeout / 1000}s.")
            }
            return (process.ExitCode, stdout.GetAwaiter().GetResult(), stderr.GetAwaiter().GetResult())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
