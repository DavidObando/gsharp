// <copyright file="Issue2502InheritedStaticMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2502 end-to-end coverage for inherited static members.</summary>
public sealed class Issue2502InheritedStaticMembersEmitTests
{
    [Fact]
    public void SourceGenericBase_AllMemberKinds_VerifyReflectAndWorkFromCSharp()
    {
        const string Source = """
            package Issue2502Source
            import System

            open class Base2502[T] {
                public class Nested2502 {
                    shared { func Value() int32 -> 9 }
                }
                shared {
                    var Field T
                    prop Prop T { get -> Field; set { Field = value } }
                    event Changed () -> void
                    func Echo(value T) T -> value
                    func Pick(value T) string -> "generic"
                    func Pick(value int32) string -> "int"
                }
            }

            open class Mid2502[U] : Base2502[U] { }
            class Derived2502 : Mid2502[string] { }

            class Probe2502 {
                shared {
                    func Run() string {
                        Derived2502.Field = "field"
                        Derived2502.Field += "!"
                        Derived2502.Prop = Derived2502.Field
                        Derived2502.Prop += "?"
                        let handler () -> void = () -> { }
                        Derived2502.Changed += handler
                        Derived2502.Changed -= handler
                        let echo (string) -> string = Derived2502.Echo
                        return Derived2502.Prop + "|" + echo("group") + "|" + Derived2502.Pick(1) + "|" + Derived2502.Nested2502.Value().ToString()
                    }
                }
            }
            """;

        var directory = CreateTestDirectory();
        try
        {
            var library = CompileGSharp(directory, "Issue2502Source", Source, "library");
            IlVerifier.Verify(library);

            var assembly = Assembly.LoadFrom(library);
            var derived = assembly.GetType("Issue2502Source.Derived2502")!;
            var closedBase = assembly.GetType("Issue2502Source.Base2502`1")!.MakeGenericType(typeof(string));
            Assert.Equal(closedBase, derived.BaseType!.BaseType);
            Assert.Equal(closedBase, derived.GetMethod("Echo", BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)!.DeclaringType);
            Assert.Equal(closedBase, derived.GetField("Field", BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)!.DeclaringType);
            Assert.Equal(closedBase, derived.GetProperty("Prop", BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)!.DeclaringType);
            Assert.Equal(closedBase, derived.GetEvent("Changed", BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)!.DeclaringType);

            var consumer = Path.Combine(directory, "Issue2502Consumer.dll");
            const string ConsumerSource = """
                using System;
                using Issue2502Source;

                Console.WriteLine(Probe2502.Run());
                Derived2502.Field = "cs-field";
                Derived2502.Prop = "cs-prop";
                Console.WriteLine(Derived2502.Field);
                Console.WriteLine(Derived2502.Prop);
                Console.WriteLine(Derived2502.Echo("cs-method"));
                Func<string, string> echo = Derived2502.Echo;
                Console.WriteLine(echo("cs-group"));
                Action handler = () => { };
                Derived2502.Changed += handler;
                Derived2502.Changed -= handler;
                Console.WriteLine("event-ok");
                """;
            EmitCSharpAssembly(consumer, "Issue2502Consumer", ConsumerSource, OutputKind.ConsoleApplication, library);

            Assert.Equal(
                "field!?|group|int|9\ncs-prop\ncs-prop\ncs-method\ncs-group\nevent-ok\n",
                Run(consumer));
        }
        finally
        {
            TryDelete(directory);
        }
    }

    [Fact]
    public void ImportedClosedGenericBase_AllMemberKinds_VerifyAndRun()
    {
        var directory = CreateTestDirectory();
        try
        {
            var importedBase = Path.Combine(directory, "Issue2502ImportedBase.dll");
            const string ImportedSource = """
                using System;

                namespace Issue2502ImportedBase;

                public class Base<T>
                {
                    public static T Field = default!;
                    public static T Prop { get; set; } = default!;
                    public static event Action? Changed;
                    public static T Echo(T value) => value;
                    public static void Raise() => Changed?.Invoke();

                    public class Nested
                    {
                        public static int Value() => 12;
                    }
                }
                """;
            EmitCSharpAssembly(importedBase, "Issue2502ImportedBase", ImportedSource, OutputKind.DynamicallyLinkedLibrary);

            const string Source = """
                package Issue2502Imported
                import System
                import Issue2502ImportedBase

                class Derived2502Imported : Base[string] { }

                func Main() {
                    Derived2502Imported.Field = "field"
                    Console.WriteLine(Derived2502Imported.Field)
                    Derived2502Imported.Prop = "prop"
                    Console.WriteLine(Derived2502Imported.Prop)
                    Console.WriteLine(Derived2502Imported.Echo("method"))
                    Derived2502Imported.Changed += () -> Console.WriteLine("event")
                    Derived2502Imported.Raise()
                    Console.WriteLine(Derived2502Imported.Nested.Value())
                }
                """;

            var executable = CompileGSharp(directory, "Issue2502Imported", Source, "exe", importedBase);
            IlVerifier.Verify(executable, additionalReferences: new[] { importedBase });
            Assert.Equal("field\nprop\nmethod\nevent\n12\n", Run(executable));
        }
        finally
        {
            TryDelete(directory);
        }
    }

    private static string CompileGSharp(
        string directory,
        string assemblyName,
        string source,
        string target,
        params string[] references)
    {
        var sourcePath = Path.Combine(directory, assemblyName + ".gs");
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);
        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        foreach (var reference in references.Concat(BclReferences.Value))
        {
            args.Add("/r:" + reference);
        }

        args.Add(sourcePath);
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(exitCode == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return outputPath;
    }

    private static void EmitCSharpAssembly(
        string outputPath,
        string assemblyName,
        string source,
        OutputKind outputKind,
        params string[] additionalReferences)
    {
        var references = TrustedPlatformReferences()
            .Concat(additionalReferences.Select(path => MetadataReference.CreateFromFile(path)))
            .ToArray();
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(outputKind));

        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string Run(string assemblyPath)
    {
        File.WriteAllText(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"), """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
              }
            }
            """);
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add(assemblyPath);
        using var process = Process.Start(startInfo)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(process.ExitCode == 0, $"exit {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static string CreateTestDirectory()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2502", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch
        {
        }
    }

    private static IEnumerable<MetadataReference> TrustedPlatformReferences()
        => ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => MetadataReference.CreateFromFile(path));

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDirectory) || !Directory.Exists(runtimeDirectory))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDirectory, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(path =>
            {
                var name = Path.GetFileName(path);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToArray();
    });
}
