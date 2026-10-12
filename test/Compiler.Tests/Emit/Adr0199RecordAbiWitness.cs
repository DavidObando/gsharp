// <copyright file="Adr0199RecordAbiWitness.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0199: shared helpers for the Roslyn witness tests. A witness compiles
/// the equivalent C# <c>record</c> with Roslyn and renders the synthesized
/// record ABI (interface list plus every synthesized member's CLR flags and
/// signature) so a G# <c>data</c> type can be compared against it line by line.
/// </summary>
internal static class Adr0199RecordAbiWitness
{
    private static readonly HashSet<string> SynthesizedNames = new(StringComparer.Ordinal)
    {
        "Equals", "GetHashCode", "ToString", "PrintMembers", "get_EqualityContract",
        "<Clone>$", "op_Equality", "op_Inequality", "Deconstruct",
    };

    /// <summary>Compiles C# with Roslyn and loads the result.</summary>
    /// <param name="source">The C# source.</param>
    /// <returns>The loaded assembly.</returns>
    public static Assembly CompileCSharp(string source)
    {
        var references = ReferenceResolver.HostTrustedPlatformAssemblyPaths()
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "RoslynWitness" + Guid.NewGuid().ToString("N"),
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        using var stream = new MemoryStream();
        var emitted = compilation.Emit(stream);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        return EmittedFixture.Load(stream.ToArray());
    }

    /// <summary>Compiles G# with the real driver, verifies the IL and loads the result.</summary>
    /// <param name="source">The G# source.</param>
    /// <returns>The loaded assembly.</returns>
    public static Assembly CompileGSharp(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_adr0199_").FullName;
        try
        {
            // EmittedFixture.Load reads the image from bytes, so the workspace can go.
            return EmittedFixture.Load(CompileGSharpToPath(source, tempDir));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>Compiles G# with the real driver into <paramref name="directory"/> and verifies the IL.</summary>
    /// <param name="source">The G# source.</param>
    /// <param name="directory">The output directory.</param>
    /// <returns>The path of the emitted library.</returns>
    public static string CompileGSharpToPath(string source, string directory)
    {
        var srcPath = Path.Combine(directory, "test.gs");
        var outPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(srcPath, source);
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(compileExit == 0, $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        IlVerifier.Verify(outPath);
        return outPath;
    }

    /// <summary>Compiles several G# files (as one package) and loads the result.</summary>
    /// <param name="files">The file names and sources.</param>
    /// <returns>The loaded assembly.</returns>
    public static Assembly CompileGSharpFiles(params (string Name, string Source)[] files)
    {
        var directory = Directory.CreateTempSubdirectory("gs_adr0199_files_").FullName;
        try
        {
            var paths = new List<string>();
            foreach (var (name, source) in files)
            {
                var path = Path.Combine(directory, name);
                File.WriteAllText(path, source);
                paths.Add(path);
            }

            var outPath = Path.Combine(directory, "test.dll");
            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int exit;
            try
            {
                exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/targetframework:net10.0" }.Concat(paths).ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(exit == 0, $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath);
            return EmittedFixture.Load(outPath);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>Compiles G# with the real driver and returns the driver's exit code and combined output.</summary>
    /// <param name="source">The G# source.</param>
    /// <returns>The exit code and the captured output.</returns>
    public static (int ExitCode, string Output) TryCompileGSharp(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_adr0199_try_").FullName;
        try
        {
            var srcPath = Path.Combine(directory, "test.gs");
            File.WriteAllText(srcPath, source);
            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            try
            {
                var exit = Program.Main(new[] { "/out:" + Path.Combine(directory, "test.dll"), "/target:library", "/targetframework:net10.0", srcPath });
                return (exit, compileOut + compileErr.ToString());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>Invokes the parameterless static function <paramref name="name"/> declared anywhere in <paramref name="assembly"/>.</summary>
    /// <param name="assembly">The loaded assembly.</param>
    /// <param name="name">The function name.</param>
    /// <returns>The function's result.</returns>
    public static object Invoke(Assembly assembly, string name)
        => assembly.GetTypes()
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly))
            .Single(m => m.Name == name && m.GetParameters().Length == 0)
            .Invoke(null, null);

    /// <summary>Renders the interface list and synthesized members of a type.</summary>
    /// <param name="type">The type to describe.</param>
    /// <returns>One line per fact, in a stable order.</returns>
    public static string Describe(Type type)
    {
        var lines = new List<string>();
        lines.Add("type " + type.Name + " " + (type.IsSealed ? "sealed" : "open") + (type.IsValueType ? " struct" : " class"));
        foreach (var iface in type.GetInterfaces().Select(DescribeType).OrderBy(n => n, StringComparer.Ordinal))
        {
            lines.Add("  interface " + iface);
        }

        const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        foreach (var ctor in type.GetConstructors(All).Where(c => !c.IsStatic).Select(Describe).OrderBy(n => n, StringComparer.Ordinal))
        {
            lines.Add("  " + ctor);
        }

        foreach (var method in type.GetMethods(All).Where(m => SynthesizedNames.Contains(m.Name)).Select(Describe).OrderBy(n => n, StringComparer.Ordinal))
        {
            lines.Add("  " + method);
        }

        return string.Join("\n", lines);
    }

    /// <summary>Gets the method flags that matter for the ABI.</summary>
    /// <param name="method">The method.</param>
    /// <returns>A compact flag string.</returns>
    public static string Flags(MethodBase method)
    {
        var sb = new StringBuilder();
        sb.Append(method.IsPublic ? "public" : method.IsFamily ? "protected" : method.IsPrivate ? "private" : method.IsAssembly ? "internal" : "other");
        if (method.IsStatic)
        {
            sb.Append(" static");
        }

        if (method.IsAbstract)
        {
            sb.Append(" abstract");
        }

        if (method.IsVirtual)
        {
            sb.Append(" virtual");
        }

        if (method.IsFinal)
        {
            sb.Append(" final");
        }

        if (method.IsVirtual && (method.Attributes & MethodAttributes.NewSlot) != 0)
        {
            sb.Append(" newslot");
        }

        if (method.IsSpecialName)
        {
            sb.Append(" specialname");
        }

        return sb.ToString();
    }

    private static string Describe(MethodBase method)
    {
        var ret = method is MethodInfo mi ? DescribeType(mi.ReturnType) : "void";
        var parameters = string.Join(", ", method.GetParameters().Select(p => DescribeType(p.ParameterType) + " " + p.Name));
        return Flags(method) + " " + ret + " " + method.Name + "(" + parameters + ")";
    }

    private static string DescribeType(Type type)
    {
        if (type.IsGenericType)
        {
            return type.Name.Split('`')[0] + "<" + string.Join(",", type.GetGenericArguments().Select(DescribeType)) + ">";
        }

        return type.Name;
    }
}
