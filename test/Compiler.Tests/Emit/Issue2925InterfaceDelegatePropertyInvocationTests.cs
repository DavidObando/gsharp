// <copyright file="Issue2925InterfaceDelegatePropertyInvocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2925: delegate properties are callable through source-interface
/// receivers for class and struct implementors.
/// </summary>
public class Issue2925InterfaceDelegatePropertyInvocationTests
{
    [Fact]
    public void InterfaceDelegateProperties_ClassAndStruct_GetOnlyAndGetSet_Invoke()
    {
        const string Source = """
            package Issue2925
            import System

            interface IActionBox {
                prop P System.Action[int32] { get }
            }

            class ClassActionBox : IActionBox {
                let Handler System.Action[int32]
                init(handler System.Action[int32]) { Handler = handler }
                prop P System.Action[int32] -> Handler
            }

            struct StructActionBox : IActionBox {
                prop P System.Action[int32] { get; set }
            }

            interface IMapper {
                prop P System.Func[int32, int32] { get; set }
            }

            class ClassMapper : IMapper {
                prop P System.Func[int32, int32] { get; set }
            }

            struct StructMapper : IMapper {
                prop P System.Func[int32, int32] { get; set }
            }

            func Main() {
                let classAction IActionBox = ClassActionBox((value int32) -> Console.WriteLine(value))
                classAction.P(1)

                var structActionValue = StructActionBox{}
                structActionValue.P = (value int32) -> Console.WriteLine(value)
                let structAction IActionBox = structActionValue
                structAction.P(2)

                let classConcrete = ClassMapper()
                classConcrete.P = (value int32) -> value + 1
                let classMapper IMapper = classConcrete
                Console.WriteLine(classMapper.P(41))

                var structConcrete = StructMapper{}
                structConcrete.P = (value int32) -> value + 2
                let structMapper IMapper = structConcrete
                Console.WriteLine(structMapper.P(40))
            }
            """;

        Assert.Equal($"1{Environment.NewLine}2{Environment.NewLine}42{Environment.NewLine}42{Environment.NewLine}", CompileAndRun(Source));
    }

    private static string CompileAndRun(string source)
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue2925", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var sourcePath = Path.Combine(outputDirectory, "Program.gs");
            var outputPath = Path.Combine(outputDirectory, "Issue2925.dll");
            File.WriteAllText(sourcePath, source);

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
                    "/out:" + outputPath,
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
                $"gsc failed:\nstdout:\n{standardOut}\nstderr:\n{standardError}");
            IlVerifier.Verify(outputPath);
            var assembly = EmittedFixture.Load(outputPath);
            _ = assembly.GetTypes();
            var entryPoint = assembly.EntryPoint
                ?? throw new InvalidOperationException("Emitted assembly has no entry point.");

            previousOut = Console.Out;
            using var output = new StringWriter();
            Console.SetOut(output);
            try
            {
                entryPoint.Invoke(
                    null,
                    entryPoint.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(previousOut);
            }

            return output.ToString().ReplaceLineEndings(Environment.NewLine);
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
