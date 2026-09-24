// <copyright file="Issue4378FixedBufferPinTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4378 / ADR-0125 amendment: gsc's <c>fixed</c> statement pins a
/// fixed-size buffer field directly (C# parity), so cs2gs translates C#
/// <c>fixed (sbyte* p = Name) { … }</c> over a fixed-size buffer field to the
/// G# <c>fixed p *int8 = this.Name { … }</c> form instead of reporting an
/// Unsupported gap (the interim behaviour from issue #4371). The end-to-end
/// test translates a minimal equivalent of the Raylib-cs
/// <c>BoneInfo</c>/<c>ModelAnimation</c> interop shape, compiles the output
/// with gsc, and runs it.
/// </summary>
public class Issue4378FixedBufferPinTranslationTests
{
    private const string RaylibShape = """
        using System;
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
        }
        """;

    /// <summary>
    /// The original #4371 repro (<c>fixed (sbyte* p = Name) return p[0];</c>
    /// inside the declaring struct) now translates to a real G# <c>fixed</c>
    /// statement over the buffer, with no Unsupported diagnostic, and the
    /// output binds through gsc.
    /// </summary>
    [Fact]
    public void FixedOverBareBufferInsideStruct_TranslatesToFixedStatement()
    {
        string printed = TranslateAndValidate("""
            public unsafe struct NativeName
            {
                public fixed sbyte Name[32];

                public sbyte First()
                {
                    fixed (sbyte* p = Name) return p[0];
                }
            }
            """);

        Assert.Contains("fixed p *int8 = this.Name {", printed);
    }

    /// <summary>
    /// A buffer reached through a movable receiver chain (a struct field of a
    /// class instance) keeps its receiver chain in the pin source.
    /// </summary>
    [Fact]
    public void FixedOverBufferOfClassField_TranslatesReceiverChain()
    {
        string printed = TranslateAndValidate("""
            public unsafe struct NativeName
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
            }
            """);

        Assert.Matches(@"fixed p \*int8 = (this\.)?N\.Name \{", printed);
    }

    /// <summary>
    /// End to end: the Raylib-cs <c>BoneInfo</c>/<c>ModelAnimation</c> shape —
    /// fixed-size name buffers pinned with <c>fixed</c>, indexed bare inside the
    /// struct, and read through a struct pointer — translates, compiles with
    /// gsc, and prints the same result C# does.
    /// </summary>
    [Fact]
    public void RaylibBoneInfoModelAnimationShape_TranslatesCompilesAndRuns()
    {
        string printed = TranslateAndValidate(RaylibShape);

        Assert.Contains("fixed Name [32]int8", printed);
        Assert.Contains("fixed p *int8 = this.Name {", printed);
        Assert.Contains("fixed p *int8 = holder.Anim.Name {", printed);

        Assert.Equal("walk|root|hip|hip", CompileAndRun(printed, "Scenario.Run()").Trim());
    }

    private static string TranslateAndValidate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-4378-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(
            gsPath,
            printed + Environment.NewLine +
                $"Console.WriteLine({callExpression})" + Environment.NewLine);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + stdout);
        return stdout;
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        var output = new StringBuilder();
        output.Append(stdoutTask.GetAwaiter().GetResult());
        output.Append(stderrTask.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
