// <copyright file="Issue4313ReferenceReceiverCallvirtTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4313: string indexing, string length, and rectangular-array length
/// use C#-compatible <c>callvirt</c> null-receiver semantics.
/// </summary>
public sealed class Issue4313ReferenceReceiverCallvirtTests
{
    private const string Source = """
        package Issue4313
        import System

        public func StringIndex4313(value string, index int32) char -> value[index]
        public func StringLength4313(value string) int32 -> value.Length
        public func RectangularLength4313(value [,]int32) int32 -> value.Length

        public func ValueTypePropertyControl4313(value DateTime) int32 -> value.Day
        public func RectangularIndexControl4313(value [,]int32) int32 -> value[0, 0]
        """;

    [Fact]
    public void ReferenceReceiverSites_UseCallvirt_WhileAdjacentControlsKeepTheirOpcodes()
    {
        var assembly = Compile();

        AssertCall(
            assembly,
            "StringIndex4313",
            OpCodes.Callvirt,
            typeof(string),
            "get_Chars");
        AssertCall(
            assembly,
            "StringLength4313",
            OpCodes.Callvirt,
            typeof(string),
            "get_Length");
        AssertCall(
            assembly,
            "RectangularLength4313",
            OpCodes.Callvirt,
            typeof(Array),
            "get_Length");

        AssertCall(
            assembly,
            "ValueTypePropertyControl4313",
            OpCodes.Call,
            typeof(DateTime),
            "get_Day");

        AssertCall(
            assembly,
            "RectangularIndexControl4313",
            OpCodes.Call,
            typeof(int[,]),
            "Get");
    }

    [Fact]
    public void ReferenceReceiverSites_StillReturnExpectedValues()
    {
        var assembly = Compile();

        Assert.Equal('C', Invoke(assembly, "StringIndex4313", "ABCD", 2));
        Assert.Equal(4, Invoke(assembly, "StringLength4313", "ABCD"));
        Assert.Equal(6, Invoke(assembly, "RectangularLength4313", new int[2, 3]));
    }

    [Fact]
    public void NullReferenceReceiver_FaultsAtEachGeneratedAccessSite()
    {
        var assembly = Compile();

        AssertNullReceiverFaultsIn(assembly, "StringIndex4313", null, 0);
        AssertNullReceiverFaultsIn(assembly, "StringLength4313", (object)null);
        AssertNullReceiverFaultsIn(assembly, "RectangularLength4313", (object)null);
    }

    private static object Invoke(Assembly assembly, string methodName, params object[] arguments)
        => GetMethod(assembly, methodName).Invoke(null, arguments)!;

    private static void AssertNullReceiverFaultsIn(
        Assembly assembly,
        string methodName,
        params object[] arguments)
    {
        var invocation = Assert.Throws<TargetInvocationException>(
            () => GetMethod(assembly, methodName).Invoke(null, arguments));
        var exception = Assert.IsType<NullReferenceException>(invocation.InnerException);
        Assert.Equal(methodName, new System.Diagnostics.StackTrace(exception).GetFrame(0)!.GetMethod()!.Name);
    }

    private static void AssertCall(
        Assembly assembly,
        string methodName,
        OpCode expectedOpcode,
        Type expectedDeclaringType,
        string expectedCalledMethod)
    {
        var method = GetMethod(assembly, methodName);
        var calls = IlInstructionReader.Read(method.GetMethodBody()!.GetILAsByteArray()!)
            .Where(instruction => instruction.MetadataToken.HasValue)
            .Select(instruction => (
                instruction.OpCode,
                Method: method.Module.ResolveMethod(instruction.MetadataToken!.Value)))
            .Where(call => call.Method?.Name == expectedCalledMethod)
            .ToArray();

        var call = Assert.Single(calls);
        Assert.Equal(expectedOpcode, call.OpCode);
        Assert.Equal(expectedDeclaringType, call.Method!.DeclaringType);
    }

    private static MethodInfo GetMethod(Assembly assembly, string methodName)
        => assembly.GetTypes()
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
            .Single(method => method.Name == methodName);

    private static Assembly Compile()
    {
        var outputDirectory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4313ReferenceReceiverCallvirtTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var sourcePath = Path.Combine(outputDirectory, "Program.gs");
            var assemblyPath = Path.Combine(outputDirectory, "Issue4313.dll");
            File.WriteAllText(sourcePath, Source);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(standardOut);
            Console.SetError(standardError);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + assemblyPath,
                    "/target:library",
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
                $"gsc failed (exit {exitCode}):\nstdout:\n{standardOut}\nstderr:\n{standardError}");
            IlVerifier.Verify(assemblyPath);
            return EmittedFixture.Load(assemblyPath);
        }
        finally
        {
            try
            {
                Directory.Delete(outputDirectory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
