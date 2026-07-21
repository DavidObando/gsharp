// <copyright file="Issue2642NullableInheritedImportedPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2642NullableInheritedImportedPropertyEmitTests
{
    [Fact]
    public void OahuSettings_NullConditionalImportedBaseProperty_Runs()
    {
        const string librarySource = """
            package Issue2642.Ref

            open class UserSettingsBase {
                prop DownloadSettings string {
                    get -> "2642"
                }
            }
            """;
        const string consumerSource = """
            package Issue2642.App
            import System
            import Issue2642.Ref

            class OahuUserSettings : UserSettingsBase { }

            class CoreEnvironment {
                shared {
                    var settings OahuUserSettings?
                    func Read() string? -> CoreEnvironment.settings?.DownloadSettings
                    func Set() { CoreEnvironment.settings = OahuUserSettings{} }
                }
            }

            Console.WriteLine(CoreEnvironment.Read())
            CoreEnvironment.Set()
            Console.WriteLine(CoreEnvironment.Read())
            """;

        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2642", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var libraryPath = Compile(directory, "Issue2642.Ref", librarySource, isLibrary: true);
            var consumerPath = Compile(directory, "Issue2642.App", consumerSource, isLibrary: false, libraryPath);
            IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(consumerPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(consumerPath);

            using var process = Process.Start(startInfo);
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\n{stderr}");
            Assert.Equal("\n2642\n", stdout.Replace("\r\n", "\n"));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string Compile(
        string directory,
        string assemblyName,
        string source,
        bool isLibrary,
        string reference = null)
    {
        var sourcePath = Path.Combine(directory, assemblyName + ".gs");
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);

        var args = new System.Collections.Generic.List<string>
        {
            "/out:" + outputPath,
            isLibrary ? "/target:library" : "/target:exe",
            "/targetframework:net10.0",
        };
        if (reference != null)
        {
            args.Add("/reference:" + reference);
        }

        args.Add(sourcePath);
        Assert.Equal(0, Program.Main(args.ToArray()));
        return outputPath;
    }
}
