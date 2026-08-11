// <copyright file="Issue3335ImportedGenericBaseOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue3335ImportedGenericBaseOverrideTests
{
    private const string LibrarySource = """
        package FindingCrossAssemblyGenericOverride

        public open class Converter[T] {
          public open func Read(item T, data []float64);
          public open func Write(data []float64) T;
          public open func ReadAll(items []T, data []float64);
          public open func WriteAll(data []float64) []T;
        }
        """;

    [Fact]
    public void ConsumerTypeArgument_SubstitutesImportedOverrideSignaturesRecursively_Runs()
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue3335", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var libraryPath = EmitLibrary(outputDirectory);

            var result = EmittedOracle.Evaluate(
                """
                package FindingCrossAssemblyGenericOverrideApp

                import FindingCrossAssemblyGenericOverride

                public class Payload {
                  public var Value float64
                }

                public class PayloadConverter : Converter[Payload] {
                  public override func Read(item Payload, data []float64) {
                    item.Value = data[0]
                  }

                  public override func Write(data []float64) Payload {
                    return Payload{ Value: data[0] }
                  }

                  public override func ReadAll(items []Payload, data []float64) {
                    items[0].Value = data[0]
                  }

                  public override func WriteAll(data []float64) []Payload {
                    return []Payload{ Payload{ Value: data[0] } }
                  }
                }

                func Main() int32 {
                  let converter Converter[Payload] = PayloadConverter()
                  let payload = converter.Write([]float64{ 1.5 })
                  converter.Read(payload, []float64{ 2.5 })
                  let payloads = converter.WriteAll([]float64{ 3.5 })
                  converter.ReadAll(payloads, []float64{ 4.5 })
                  return payload.Value == 2.5 && payloads[0].Value == 4.5 ? 0 : 1
                }
                """,
                new[] { libraryPath });

            Assert.Empty(result.Diagnostics);
            Assert.Equal(0, result.ExitCode);
            Assert.Equal(0, Assert.IsType<int>(result.Value));
        }
        finally
        {
            Directory.Delete(outputDirectory, recursive: true);
        }
    }

    [Fact]
    public void NestedConsumerTypeArgument_Mismatch_RemainsGS0185()
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue3335", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var libraryPath = EmitLibrary(outputDirectory);
            var result = EmittedOracle.Evaluate(
                """
                package FindingCrossAssemblyGenericOverrideApp

                import FindingCrossAssemblyGenericOverride

                public class Payload {
                  public var Value float64
                }

                public open class BadConverter : Converter[Payload] {
                  public override func Read(item Payload, data []float64) {
                  }

                  public override func Write(data []float64) Payload {
                    return Payload{}
                  }

                  public override func ReadAll(items []float64, data []float64) {
                  }

                  public override func WriteAll(data []float64) []Payload {
                    return []Payload{}
                  }
                }
                """,
                new[] { libraryPath });

            Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0185");
        }
        finally
        {
            Directory.Delete(outputDirectory, recursive: true);
        }
    }

    private static string EmitLibrary(string outputDirectory)
    {
        var libraryPath = Path.Combine(outputDirectory, "FindingCrossAssemblyGenericOverride.dll");
        var library = new Compilation(SyntaxTree.Parse(SourceText.From(LibrarySource)))
        {
            IsLibrary = true,
        };

        using var output = File.Create(libraryPath);
        var emit = library.Emit(
            output,
            pdbStream: null,
            refStream: null,
            assemblyName: "FindingCrossAssemblyGenericOverride");
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return libraryPath;
    }
}
