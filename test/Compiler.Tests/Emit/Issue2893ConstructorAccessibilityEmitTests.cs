// <copyright file="Issue2893ConstructorAccessibilityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Regression coverage for issue #2893.</summary>
public sealed class Issue2893ConstructorAccessibilityEmitTests
{
    private const string Source = """
        package Issue2893
        import System

        class PublicCtor {
            var Value int32
            public init(value int32) { Value = value }
        }

        class InternalCtor {
            internal init(value int32) {}
        }

        open class ProtectedCtor {
            protected init(value int32) {}
        }

        class PrivateCtor {
            private init(value int32) {}
        }

        class DefaultCtor {
            var Value int32
            init(value int32) { Value = value }
        }

        class FuncInitInternal {
            internal func init(value int32) {}
        }

        class ConvenienceCtor {
            public init(value int32, other int32) {}
            private convenience init(value int32) { init(value, 0) }
        }

        class Outer {
            class NestedPrivate {
                private init(value int32) {}
            }
        }

        class GenericPrivate[T] {
            private init(value int32) {}
        }

        data class DataPrivate {
            private init(value int32) {}
        }

        struct StructPrivate {
            private init(value int32) {}
        }

        class SynthesizedDefault {
            var Value int32 = 33
        }

        class PrimaryCtor(value int32) {}

        class StaticInitializer {
            shared {
                var Value int32
                init { Value = 44 }
                func Read() int32 -> Value
            }
        }

        func Main() {
            Console.WriteLine(PublicCtor(11).Value)
            Console.WriteLine(DefaultCtor(22).Value)
            Console.WriteLine(SynthesizedDefault().Value)
            Console.WriteLine(PrimaryCtor(34).value)
            Console.WriteLine(StaticInitializer.Read())
        }
        """;

    [Fact]
    public void NonPublicExplicitConstructors_EmitDeclaredAccessibility()
    {
        Verify(types =>
        {
            AssertConstructorVisibility(types, "Issue2893.InternalCtor", MethodAttributes.Assembly, typeof(int));
            AssertConstructorVisibility(types, "Issue2893.ProtectedCtor", MethodAttributes.Family, typeof(int));
            AssertConstructorVisibility(types, "Issue2893.PrivateCtor", MethodAttributes.Private, typeof(int));
            AssertConstructorVisibility(types, "Issue2893.FuncInitInternal", MethodAttributes.Assembly, typeof(int));
            AssertConstructorVisibility(types, "Issue2893.ConvenienceCtor", MethodAttributes.Private, typeof(int));
            AssertConstructorVisibility(types, "Issue2893.Outer+NestedPrivate", MethodAttributes.Private, typeof(int));
            AssertConstructorVisibility(types, "Issue2893.GenericPrivate`1", MethodAttributes.Private, typeof(int));
            AssertConstructorVisibility(types, "Issue2893.DataPrivate", MethodAttributes.Private, typeof(int));
            AssertConstructorVisibility(types, "Issue2893.StructPrivate", MethodAttributes.Private, typeof(int));
        });
    }

    [Fact]
    public void PublicDefaultAndStaticConstructors_RemainUnchanged()
    {
        Verify(types =>
        {
            AssertConstructorVisibility(types, "Issue2893.PublicCtor", MethodAttributes.Public, typeof(int));
            AssertConstructorVisibility(types, "Issue2893.DefaultCtor", MethodAttributes.Public, typeof(int));
            AssertConstructorVisibility(types, "Issue2893.SynthesizedDefault", MethodAttributes.Public);
            AssertConstructorVisibility(types, "Issue2893.PrimaryCtor", MethodAttributes.Public, typeof(int));

            var staticInitializer = types.Single(type => type.FullName == "Issue2893.StaticInitializer").TypeInitializer;
            Assert.NotNull(staticInitializer);
            Assert.Equal(
                MethodAttributes.Private,
                staticInitializer.Attributes & MethodAttributes.MemberAccessMask);
            Assert.True(staticInitializer.IsStatic);
        });
    }

    private static void Verify(Action<Type[]> assertions)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2893ConstructorAccessibilityEmitTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var assemblyPath = Compile(Source, directory);
            IlVerifier.Verify(assemblyPath);

            var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
            var types = assembly.GetTypes();
            Assert.Equal(16, types.Length);
            assertions(types);
            Assert.Equal($"11{Environment.NewLine}22{Environment.NewLine}33{Environment.NewLine}34{Environment.NewLine}44{Environment.NewLine}", Run(assemblyPath, directory));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string Compile(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "Program.gs");
        var assemblyPath = Path.Combine(directory, "Program.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exitCode == 0,
            $"gsc exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return assemblyPath;
    }

    private static void AssertConstructorVisibility(
        Type[] types,
        string typeName,
        MethodAttributes expected,
        params Type[] parameterTypes)
    {
        var type = types.Single(candidate => candidate.FullName == typeName);
        var constructor = type.GetConstructor(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly,
            binder: null,
            parameterTypes,
            modifiers: null);

        Assert.NotNull(constructor);
        Assert.Equal(expected, constructor.Attributes & MethodAttributes.MemberAccessMask);
    }

    private static string Run(string assemblyPath, string directory)
    {
        var runtimeConfigPath = Path.ChangeExtension(assemblyPath, "runtimeconfig.json");
        File.WriteAllText(
            runtimeConfigPath,
            """
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
            WorkingDirectory = directory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(runtimeConfigPath);
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start emitted program.");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        Assert.True(process.WaitForExit(30_000), "Emitted program timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"emitted program exited {process.ExitCode}\nstdout:\n{stdout.Result}\nstderr:\n{stderr.Result}");
        return stdout.Result.ReplaceLineEndings(Environment.NewLine);
    }
}
