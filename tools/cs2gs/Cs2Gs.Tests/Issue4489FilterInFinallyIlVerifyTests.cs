// <copyright file="Issue4489FilterInFinallyIlVerifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using Cs2Gs.Pipeline;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Xunit;
using Region = GSharp.Tests.IlVerifyFilterInFinallyRule.Region;

namespace Cs2Gs.Tests;

/// <summary>
/// #4489: the self-migration ilverify stage ignores exactly one ilverify
/// 10.0.8 false positive (upstream dotnet/runtime#134711), a
/// <c>StackUnderflow</c> at the start of a filter block that lies inside a
/// <c>finally</c>/<c>fault</c> handler, and keeps every other stack underflow.
/// </summary>
[Collection(IlVerifyPipelineCollection.Name)]
public class Issue4489FilterInFinallyIlVerifyTests
{
    // The exact nightly line from #4489.
    private const string NightlyLine =
        "[IL]: Error [StackUnderflow]: [GSharp.Core.Tests.dll : GSharp.Core.Tests.CodeAnalysis.Binding." +
        "EventSubscriptionAccessibilityBinderTests::CompileAgainstLibrary(string, System.Func`2<string,string>)]" +
        "[offset 0x000001C6] Stack underflow.";

    [Fact]
    public void TryParse_ReadsTheNightlyLine()
    {
        Assert.True(IlVerifyFilterInFinallyRule.TryParse(
            NightlyLine,
            out string type,
            out string method,
            out int parameterCount,
            out int offset));
        Assert.Equal("GSharp.Core.Tests.CodeAnalysis.Binding.EventSubscriptionAccessibilityBinderTests", type);
        Assert.Equal("CompileAgainstLibrary", method);
        Assert.Equal(2, parameterCount);
        Assert.Equal(0x1C6, offset);

        Assert.False(IlVerifyFilterInFinallyRule.TryParse(
            NightlyLine.Replace("[StackUnderflow]", "[StackUnexpected]", StringComparison.Ordinal),
            out _,
            out _,
            out _,
            out _));
    }

    [Theory]
    [InlineData(ExceptionRegionKind.Finally, 20, true)]
    [InlineData(ExceptionRegionKind.Fault, 20, true)]
    [InlineData(ExceptionRegionKind.Finally, 21, false)] // inside the filter, not its start
    [InlineData(ExceptionRegionKind.Finally, 12, false)] // inside the finally, not a filter start
    [InlineData(ExceptionRegionKind.Catch, 20, false)] // ILVerify gives a catch handler's filter the catch type
    public void FilterStartMatcher_RequiresFilterStartWhoseInnermostHandlerIsFinallyOrFault(
        ExceptionRegionKind outerHandlerKind,
        int reportedOffset,
        bool expected)
    {
        var regions = new List<Region>
        {
            // outer: try [0,10), handler [10,60)
            new Region(outerHandlerKind, 0, 10, 10, 50, -1),

            // inner (inside the outer handler): try [12,20), filter [20,25), handler [25,40)
            new Region(ExceptionRegionKind.Filter, 12, 8, 25, 15, 20),
        };

        Assert.Equal(expected, IlVerifyFilterInFinallyRule.IsFilterStartInsideFinallyOrFault(regions, reportedOffset));
    }

    [Fact]
    public void FilterStartMatcher_RejectsMethodLevelFilter_AndCatchNestedInFinally()
    {
        var methodLevel = new List<Region>
        {
            new Region(ExceptionRegionKind.Filter, 0, 8, 13, 5, 8),
        };
        Assert.False(IlVerifyFilterInFinallyRule.IsFilterStartInsideFinallyOrFault(methodLevel, 8));

        // finally [10,70) > catch handler [12,60) > filter start 20: the
        // innermost enclosing handler is the catch, which ILVerify handles.
        var catchInsideFinally = new List<Region>
        {
            new Region(ExceptionRegionKind.Finally, 0, 10, 10, 60, -1),
            new Region(ExceptionRegionKind.Catch, 10, 2, 12, 48, -1),
            new Region(ExceptionRegionKind.Filter, 14, 6, 25, 10, 20),
        };
        Assert.False(IlVerifyFilterInFinallyRule.IsFilterStartInsideFinallyOrFault(catchInsideFinally, 20));

        // Same filter directly in the finally handler: matched.
        var direct = new List<Region>
        {
            new Region(ExceptionRegionKind.Finally, 0, 10, 10, 60, -1),
            new Region(ExceptionRegionKind.Filter, 14, 6, 25, 10, 20),
        };
        Assert.True(IlVerifyFilterInFinallyRule.IsFilterStartInsideFinallyOrFault(direct, 20));
    }

    /// <summary>
    /// Real ilverify on the issue's C# compiled by Roslyn (which emits the same
    /// layout gsc does): the filter-in-finally method, declared on a nested
    /// type with two parameters, is reported by ilverify yet dropped by the
    /// stage's runner, and runs correctly. The same assembly with a genuine
    /// underflow patched into another method still fails verification.
    /// </summary>
    [Fact]
    public void Runner_DropsFilterInFinallyUnderflow_KeepsRealUnderflow()
    {
        if (!IlVerifyRunner.IsEnabled || !new IlVerifyRunner().EnsureToolAvailable())
        {
            return;
        }

        string directory = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", "issue4489", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string clean = Path.Combine(directory, "Clean.dll");
            byte[] image = CompileFixture();
            File.WriteAllBytes(clean, image);
            IlVerifyResult cleanResult = new IlVerifyRunner().Verify(clean);
            Assert.Contains("[StackUnderflow]", cleanResult.Output, StringComparison.Ordinal);
            Assert.Contains("Demo.Outer+Inner::Run(string, int32)", cleanResult.Output, StringComparison.Ordinal);
            Assert.True(cleanResult.Succeeded, cleanResult.Output);
            Assert.Empty(cleanResult.Errors);

            var context = new AssemblyLoadContext("issue4489-" + Guid.NewGuid().ToString("N"), isCollectible: true);
            try
            {
                Type inner = context.LoadFromAssemblyPath(clean).GetType("Demo.Outer+Inner", throwOnError: true);
                Assert.Equal("x", inner.GetMethod("Run").Invoke(null, new object[] { "x", 1 }));
            }
            finally
            {
                context.Unload();
            }

            // Broken(): `ldnull; call GC.KeepAlive; ret` -> `pop; ...`, a real
            // underflow at offset 0 of a method with no exception regions.
            string broken = Path.Combine(directory, "Broken.dll");
            File.WriteAllBytes(broken, PatchFirstIlByte(image, "Broken", expected: 0x14, replacement: 0x26));
            IlVerifyResult brokenResult = new IlVerifyRunner().Verify(broken);
            Assert.False(brokenResult.Succeeded, brokenResult.Output);
            Assert.Contains("Demo.Outer+Inner::Run(string, int32)", brokenResult.Output, StringComparison.Ordinal);
            IlVerifyError remaining = Assert.Single(brokenResult.Errors);
            Assert.Equal("StackUnderflow", remaining.Code);
            Assert.Equal("Demo.Outer+Inner::Broken()", remaining.Method);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static byte[] CompileFixture()
    {
        const string Source = """
            namespace Demo
            {
                public static class Outer
                {
                    public static class Inner
                    {
                        public static string Run(string s, int n)
                        {
                            try
                            {
                                return s;
                            }
                            finally
                            {
                                try
                                {
                                    System.GC.KeepAlive(s);
                                }
                                catch (System.Exception ex) when (ex is System.IO.IOException)
                                {
                                }
                            }
                        }

                        public static void Broken()
                        {
                            System.GC.KeepAlive(null);
                        }
                    }
                }
            }
            """;
        string runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        var compilation = CSharpCompilation.Create(
            "Issue4489Fixture" + Guid.NewGuid().ToString("N"),
            new[] { CSharpSyntaxTree.ParseText(Source) },
            new[]
            {
                MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
                MetadataReference.CreateFromFile(Path.Combine(runtimeDir, "System.Runtime.dll")),
            },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release));
        using var stream = new MemoryStream();
        EmitResult emit = compilation.Emit(stream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return stream.ToArray();
    }

    private static byte[] PatchFirstIlByte(byte[] image, string methodName, byte expected, byte replacement)
    {
        byte[] bytes = (byte[])image.Clone();
        using var pe = new PEReader(new MemoryStream(image, writable: false));
        MetadataReader md = pe.GetMetadataReader();
        MethodDefinition method = md.MethodDefinitions
            .Select(md.GetMethodDefinition)
            .Single(m => md.GetString(m.Name) == methodName);
        MethodBodyBlock body = pe.GetMethodBody(method.RelativeVirtualAddress);
        Assert.Empty(body.ExceptionRegions);
        Assert.Equal(expected, body.GetILBytes()[0]);
        SectionHeader section = pe.PEHeaders.SectionHeaders.Single(h =>
            method.RelativeVirtualAddress >= h.VirtualAddress
            && method.RelativeVirtualAddress < h.VirtualAddress + h.SizeOfRawData);
        int header = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData;
        bool tiny = (bytes[header] & 0x3) == 0x2;
        int code = header + (tiny ? 1 : (bytes[header + 1] >> 4) * 4);
        bytes[code] = replacement;
        return bytes;
    }
}
