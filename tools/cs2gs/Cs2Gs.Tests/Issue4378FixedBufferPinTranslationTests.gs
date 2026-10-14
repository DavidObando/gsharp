// <copyright file="Issue4378FixedBufferPinTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Issue #4378 / ADR-0125 amendment: gsc's `fixed` statement pins a
/// fixed-size buffer field directly (C# parity), so cs2gs translates C#
/// `fixed (sbyte* p = Name) { … }` over a fixed-size buffer field to the
/// G# `fixed p *int8 = this.Name { … }` form instead of reporting an
/// Unsupported gap (the interim behaviour from issue #4371). The end-to-end
/// test translates a minimal equivalent of the Raylib-cs
/// `BoneInfo`/`ModelAnimation` interop shape, compiles the output
/// with gsc, and runs it.
open class Issue4378FixedBufferPinTranslationTests {
    /// The original #4371 repro (`fixed (sbyte* p = Name) return p[0];`
    /// inside the declaring struct) now translates to a real G# `fixed`
    /// statement over the buffer, with no Unsupported diagnostic, and the
    /// output binds through gsc.
    @Fact
    func FixedOverBareBufferInsideStruct_TranslatesToFixedStatement() {
        let printed = TranslateAndValidate(`public unsafe struct NativeName
{
    public fixed sbyte Name[32];

    public sbyte First()
    {
        fixed (sbyte* p = Name) return p[0];
    }
}`)
        Assert.Contains("fixed p *int8 = this.Name {", printed)
    }

    /// A buffer reached through a movable receiver chain (a struct field of a
    /// class instance) keeps its receiver chain in the pin source.
    @Fact
    func FixedOverBufferOfClassField_TranslatesReceiverChain() {
        let printed = TranslateAndValidate(`public unsafe struct NativeName
{
    public fixed sbyte Name[32];
}

public unsafe class Holder
{
    public NativeName N;

    public int Sum()
    {
        int total = 0;
        fixed (sbyte* p = N.Name)
        {
            for (int i = 0; i < 4; i++)
            {
                total += p[i];
            }
        }

        return total;
    }
}`)
        Assert.Matches("fixed p \\*int8 = (this\\.)?N\\.Name \\{", printed)
    }

    /// End to end: the Raylib-cs `BoneInfo`/`ModelAnimation` shape —
    /// fixed-size name buffers pinned with `fixed`, indexed bare inside the
    /// struct, and read through a struct pointer — translates, compiles with
    /// gsc, and prints the same result C# does.
    @Fact
    func RaylibBoneInfoModelAnimationShape_TranslatesCompilesAndRuns() {
        let printed = TranslateAndValidate(RaylibShape)
        Assert.Contains("fixed Name [32]int8", printed)
        Assert.Contains("fixed p *int8 = this.Name {", printed)
        Assert.Contains("fixed p *int8 = holder.Anim.Name {", printed)
        Assert.Equal("walk|root|hip|hip", CompileAndRun(printed, "Scenario.Run()").Trim())
    }

    shared {
        private const RaylibShape string = `using System;
using System.Runtime.InteropServices;

public unsafe struct BoneInfo
{
    public fixed sbyte Name[32];
    public int Parent;

    public string GetName()
    {
        fixed (sbyte* p = Name)
        {
            return Marshal.PtrToStringUTF8((IntPtr)p);
        }
    }

    public void SetName(string s)
    {
        int n = Math.Min(s.Length, 31);
        for (int i = 0; i < n; i++)
        {
            Name[i] = (sbyte)s[i];
        }

        Name[n] = 0;
    }
}

public unsafe struct ModelAnimation
{
    public int BoneCount;
    public BoneInfo* Bones;
    public fixed sbyte Name[32];

    public string GetName()
    {
        fixed (sbyte* p = Name) return Marshal.PtrToStringUTF8((IntPtr)p);
    }

    public string BoneName(int i)
    {
        sbyte* p = Bones[i].Name;
        return Marshal.PtrToStringUTF8((IntPtr)p);
    }
}

public unsafe class AnimHolder
{
    public ModelAnimation Anim;
}

public static unsafe class Scenario
{
    public static string Run()
    {
        BoneInfo[] bones = new BoneInfo[2];
        bones[0].SetName("root");
        bones[1].SetName("hip");
        bones[1].Parent = 0;

        var holder = new AnimHolder();
        fixed (BoneInfo* pb = bones)
        {
            holder.Anim.BoneCount = 2;
            holder.Anim.Bones = pb;
            fixed (sbyte* p = holder.Anim.Name)
            {
                p[0] = (sbyte)'w';
                p[1] = (sbyte)'a';
                p[2] = (sbyte)'l';
                p[3] = (sbyte)'k';
                p[4] = 0;
            }

            return holder.Anim.GetName() + "|" + holder.Anim.BoneName(0) + "|" +
                holder.Anim.BoneName(1) + "|" + bones[1].GetName();
        }
    }
}`

        private func TranslateAndValidate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-4378-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Snippet.gs")
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(
                    gsPath,
                    printed + Environment.NewLine + "Console.WriteLine($callExpression)" + Environment.NewLine
                )
                let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
                Assert.True(
                    compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
                )
                let (runExit, stdout) = RunDotnet("\"$dllPath\"")
                Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + stdout)
                return stdout
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch (IOException) {
                    // Best-effort cleanup.

                } catch (UnauthorizedAccessException) {
                    // Best-effort cleanup.

                }
            }
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let stdoutTask = process!!.StandardOutput.ReadToEndAsync()
            let stderrTask = process!!.StandardError.ReadToEndAsync()
            process!!.WaitForExit()
            let output = StringBuilder()
            output.Append(stdoutTask.GetAwaiter().GetResult())
            output.Append(stderrTask.GetAwaiter().GetResult())
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
