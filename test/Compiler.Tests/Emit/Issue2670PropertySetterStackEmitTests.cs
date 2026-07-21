// <copyright file="Issue2670PropertySetterStackEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2670: nested symbolic generic types stay exact in property setters.</summary>
public sealed class Issue2670PropertySetterStackEmitTests
{
    [Fact]
    public void ExactUiSetters_RunAndIlVerify()
    {
        const string source = """
            package Oahu.Core.UI.Avalonia.ViewModels

            import System
            import System.Collections.Generic
            import System.Collections.ObjectModel

            class ConversionItemViewModel {}
            class BookItemViewModel {}

            class ConversionViewModel {
                var conversions ObservableCollection[ConversionItemViewModel] = ObservableCollection[ConversionItemViewModel]()

                prop Conversions ObservableCollection[ConversionItemViewModel] {
                    get -> conversions
                    set {
                        if !EqualityComparer[ObservableCollection[ConversionItemViewModel]].Default.Equals(conversions, value) {
                            conversions = value
                        }
                    }
                }
            }

            class BookLibraryViewModel {
                var books ObservableCollection[BookItemViewModel] = ObservableCollection[BookItemViewModel]()

                prop Books ObservableCollection[BookItemViewModel] {
                    get -> books
                    set {
                        if !EqualityComparer[ObservableCollection[BookItemViewModel]].Default.Equals(books, value) {
                            books = value
                        }
                    }
                }
            }

            func Main() {
                let conversion = ConversionViewModel()
                let conversions = ObservableCollection[ConversionItemViewModel]()
                conversions.Add(ConversionItemViewModel())
                conversion.Conversions = conversions
                Console.WriteLine(conversion.Conversions.Count)

                let library = BookLibraryViewModel()
                let books = ObservableCollection[BookItemViewModel]()
                books.Add(BookItemViewModel())
                library.Books = books
                Console.WriteLine(library.Books.Count)
            }
            """;

        using var result = Compile(source);
        Assert.Equal("1\n1\n", Run(result.OutputPath));

        var loadContext = new AssemblyLoadContext("Issue2670-" + Guid.NewGuid(), isCollectible: true);
        try
        {
            using var stream = File.OpenRead(result.OutputPath);
            var assembly = loadContext.LoadFromStream(stream);
            AssertSetterType(
                assembly,
                "Oahu.Core.UI.Avalonia.ViewModels.ConversionViewModel",
                "Conversions",
                "Oahu.Core.UI.Avalonia.ViewModels.ConversionItemViewModel");
            AssertSetterType(
                assembly,
                "Oahu.Core.UI.Avalonia.ViewModels.BookLibraryViewModel",
                "Books",
                "Oahu.Core.UI.Avalonia.ViewModels.BookItemViewModel");
        }
        finally
        {
            loadContext.Unload();
        }

        IlVerifier.Verify(result.OutputPath);
    }

    private static void AssertSetterType(
        Assembly assembly,
        string containingTypeName,
        string propertyName,
        string elementTypeName)
    {
        var setter = assembly.GetType(containingTypeName, throwOnError: true)!
            .GetProperty(propertyName)!.SetMethod!;
        Assert.Equal("set_" + propertyName, setter.Name);
        var collectionType = Assert.Single(setter.GetParameters()).ParameterType;
        Assert.Equal(typeof(System.Collections.ObjectModel.ObservableCollection<>), collectionType.GetGenericTypeDefinition());
        Assert.Equal(elementTypeName, Assert.Single(collectionType.GetGenericArguments()).FullName);
    }

    private static CompilationResult Compile(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2670-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "ViewModels.gs");
        var outputPath = Path.Combine(directory, "Oahu.UI.dll");
        File.WriteAllText(sourcePath, source);

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        args.AddRange(TrustedPlatformAssemblies().Select(path => "/reference:" + path));
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

        Assert.True(
            exitCode == 0,
            $"compile failed ({exitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return new CompilationResult(directory, outputPath);
    }

    private static string Run(string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(value)
            ? Enumerable.Empty<string>()
            : value.Split(Path.PathSeparator);
    }

    private sealed class CompilationResult : IDisposable
    {
        public CompilationResult(string directoryPath, string outputPath)
        {
            DirectoryPath = directoryPath;
            OutputPath = outputPath;
        }

        public string DirectoryPath { get; }

        public string OutputPath { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(DirectoryPath, recursive: true);
            }
            catch
            {
                // Best effort cleanup on Windows where loaded assemblies may remain locked.
            }
        }
    }
}
