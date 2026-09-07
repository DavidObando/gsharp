// <copyright file="Issue3940NestedGenericCallSiteSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using GSharp.Compiler;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3940: substituting a generic method's own arguments through a nested
/// generic return or parameter type must not drop the enclosing construction.
/// </summary>
public class Issue3940NestedGenericCallSiteSubstitutionTests
{
    [Fact]
    public void NestedGenericCallSites_SubstituteEveryLevelWithoutChangingDefinitions()
    {
        const string source = """
            package Issue3940
            import System

            class Outer3940[T] {
                class Inner3940[U] {
                    var item T = default(T)
                    var other U = default(U)
                }

                func Make3940[U](v T, w U) Inner3940[U] {
                    return Inner3940[U]{item: v, other: w}
                }

                func Pass3940[U](value Inner3940[U]) Inner3940[U] {
                    return value
                }

                shared {
                    func MakeShared3940[U](v T, w U) Inner3940[U] {
                        return Inner3940[U]{item: v, other: w}
                    }

                    func PassShared3940[U](value Inner3940[U]) Inner3940[U] {
                        return value
                    }
                }
            }

            class Other3940[A] {
                class Node3940[B] {
                    var a A = default(A)
                    var b B = default(B)
                }
            }

            class DeepOuter3940[T] {
                class Mid3940[V] {
                    class Leaf3940[W] {
                        var outer T = default(T)
                        var middle V = default(V)
                        var own W = default(W)
                    }

                    class PlainLeaf3940 {
                        var outer T = default(T)
                        var middle V = default(V)
                    }
                }

                func PassDeep3940[V, W](
                    value DeepOuter3940[T].Mid3940[V].Leaf3940[W])
                    DeepOuter3940[T].Mid3940[V].Leaf3940[W] {
                    return value
                }

                func PassPlain3940[V, W](
                    value DeepOuter3940[T].Mid3940[V].PlainLeaf3940,
                    ignored W)
                    DeepOuter3940[T].Mid3940[V].PlainLeaf3940 {
                    return value
                }

                func ClosedControl3940[U](ignored U) Other3940[int32].Node3940[string] {
                    return Other3940[int32].Node3940[string]{a: 9, b: "closed"}
                }
            }

            class Flat3940 {
                class Inner3940[U] {
                    var value U = default(U)
                }

                func Make3940[U](value U) Inner3940[U] {
                    return Inner3940[U]{value: value}
                }
            }

            let instance3940 = Outer3940[int32]().Pass3940[string](
                Outer3940[int32]().Make3940[string](4, "i"))
            let shared3940 = Outer3940[string].PassShared3940[int32](
                Outer3940[string].MakeShared3940[int32]("s", 7))
            let deep3940 = DeepOuter3940[int32]().PassDeep3940[string, bool](
                DeepOuter3940[int32].Mid3940[string].Leaf3940[bool]{
                    outer: 5,
                    middle: "m",
                    own: true
                })
            let plain3940 = DeepOuter3940[string]().PassPlain3940[int32, bool](
                DeepOuter3940[string].Mid3940[int32].PlainLeaf3940{
                    outer: "o",
                    middle: 8
                },
                false)
            let closed3940 = DeepOuter3940[bool]().ClosedControl3940[string]("ignored")
            let flat3940 = Flat3940().Make3940[int32](11)

            Console.WriteLine(instance3940.item.ToString() + "/" + instance3940.other)
            Console.WriteLine(shared3940.item + "/" + shared3940.other.ToString())
            Console.WriteLine(
                deep3940.outer.ToString()
                + "/"
                + deep3940.middle.ToString()
                + "/"
                + deep3940.own.ToString())
            Console.WriteLine(plain3940.outer.ToString() + "/" + plain3940.middle.ToString())
            Console.WriteLine(closed3940.a.ToString() + "/" + closed3940.b)
            Console.WriteLine(flat3940.value.ToString())
            """;

        var result = CompileVerifyAndRun(source);
        try
        {
            Assert.Equal(
                new[] { "4/i", "s/7", "5/m/True", "o/8", "9/closed", "11" },
                result.Output);
            AssertConstructedGenericMethodCallTokens(
                result.AssemblyPath,
                "Make3940",
                "Pass3940",
                "MakeShared3940",
                "PassShared3940",
                "PassDeep3940",
                "PassPlain3940",
                "ClosedControl3940");

            var assembly = EmittedFixture.Load(result.AssemblyPath);
            var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
            AssertGenericArguments(program, "instance3940", typeof(int), typeof(string));
            AssertGenericArguments(program, "shared3940", typeof(string), typeof(int));
            AssertGenericArguments(program, "deep3940", typeof(int), typeof(string), typeof(bool));
            AssertGenericArguments(program, "plain3940", typeof(string), typeof(int));
            AssertGenericArguments(program, "closed3940", typeof(int), typeof(string));
            AssertGenericArguments(program, "flat3940", typeof(int));

            var outer = assembly.GetTypes().Single(t => t.Name == "Outer3940`1");
            AssertOpenNestedSignature(outer.GetMethod("Make3940")!, expectedMethodParameterCount: 1);
            AssertOpenNestedSignature(outer.GetMethod("Pass3940")!, expectedMethodParameterCount: 1);
            AssertOpenNestedSignature(outer.GetMethod("MakeShared3940")!, expectedMethodParameterCount: 1);
            AssertOpenNestedSignature(outer.GetMethod("PassShared3940")!, expectedMethodParameterCount: 1);

            var deepOuter = assembly.GetTypes().Single(t => t.Name == "DeepOuter3940`1");
            AssertOpenNestedSignature(deepOuter.GetMethod("PassDeep3940")!, expectedMethodParameterCount: 2);

            var passPlain = deepOuter.GetMethod("PassPlain3940")!;
            var plainArguments = passPlain.ReturnType.GetGenericArguments();
            Assert.Equal(2, plainArguments.Length);
            Assert.True(plainArguments[0].IsGenericTypeParameter);
            Assert.True(plainArguments[1].IsGenericMethodParameter);

            var closedControl = deepOuter.GetMethod("ClosedControl3940")!;
            Assert.Equal(
                new[] { typeof(int), typeof(string) },
                closedControl.ReturnType.GetGenericArguments());
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(result.AssemblyPath)!, recursive: true);
        }
    }

    private static void AssertConstructedGenericMethodCallTokens(
        string assemblyPath,
        params string[] expectedNames)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        var found = new HashSet<string>(StringComparer.Ordinal);

        var methodSpecCount = metadata.GetTableRowCount(TableIndex.MethodSpec);
        for (var row = 1; row <= methodSpecCount; row++)
        {
            var handle = MetadataTokens.MethodSpecificationHandle(row);
            var specification = metadata.GetMethodSpecification(handle);
            if (specification.Method.Kind != HandleKind.MemberReference)
            {
                continue;
            }

            var member = metadata.GetMemberReference((MemberReferenceHandle)specification.Method);
            var name = metadata.GetString(member.Name);
            if (expectedNames.Contains(name, StringComparer.Ordinal))
            {
                Assert.Equal(HandleKind.TypeSpecification, member.Parent.Kind);
                found.Add(name);
            }
        }

        Assert.Equal(expectedNames.OrderBy(name => name), found.OrderBy(name => name));
    }

    private static void AssertGenericArguments(Type program, string fieldName, params Type[] expected)
    {
        var field = program.GetField(
            fieldName,
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(field);
        Assert.Equal(expected, field.FieldType.GetGenericArguments());
    }

    private static void AssertOpenNestedSignature(MethodInfo method, int expectedMethodParameterCount)
    {
        var returnArguments = method.ReturnType.GetGenericArguments();
        Assert.Equal(expectedMethodParameterCount + 1, returnArguments.Length);
        Assert.True(returnArguments[0].IsGenericTypeParameter);
        Assert.All(returnArguments.Skip(1), argument => Assert.True(argument.IsGenericMethodParameter));

        var nestedParameter = method.GetParameters()
            .Select(parameter => parameter.ParameterType)
            .FirstOrDefault(type => type.IsGenericType && type.GetGenericTypeDefinition() == method.ReturnType.GetGenericTypeDefinition());
        if (nestedParameter != null)
        {
            Assert.Equal(returnArguments, nestedParameter.GetGenericArguments());
        }
    }

    private static (string[] Output, string AssemblyPath) CompileVerifyAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_3940_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "Program.gs");
            var assemblyPath = Path.Combine(directory, "Program.dll");
            File.WriteAllText(sourcePath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
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
                Console.SetError(previousErr);
            }

            Assert.True(exitCode == 0, $"gsc failed:\n{compileOut}\n{compileErr}");
            IlVerifier.Verify(assemblyPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(assemblyPath);

            using var process = Process.Start(startInfo);
            var stdout = process!.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"runtime failed:\n{stdout}\n{stderr}");

            return (
                stdout.ReplaceLineEndings(Environment.NewLine)
                    .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries),
                assemblyPath);
        }
        catch
        {
            Directory.Delete(directory, recursive: true);
            throw;
        }
    }
}
