// <copyright file="Issue3335ImportedGenericBaseOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.IO
import System.Linq
import Xunit

class Issue3335ImportedGenericBaseOverrideTests {
    @Fact
    func ConsumerTypeArgument_SubstitutesImportedOverrideSignaturesRecursively_Runs() {
        let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue3335", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(outputDirectory)
        try {
            let libraryPath = EmitLibrary(outputDirectory)
            let result = EmittedOracle.Evaluate(`package FindingCrossAssemblyGenericOverrideApp

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

  public override func EchoAll[U](items []U) []U {
    return items
  }
}

public class DeepPayloadConverter : DeepMid[Payload] {
  public override func Transform(item Box[Payload]) Box[Payload] {
    return item
  }

  public override prop Current Box[Payload] {
    get {
      return Box[Payload]()
    }
  }
}

func Main() int32 {
  let converter Converter[Payload] = PayloadConverter()
  let payload = converter.Write([]float64{ 1.5 })
  converter.Read(payload, []float64{ 2.5 })
  let payloads = converter.WriteAll([]float64{ 3.5 })
  converter.ReadAll(payloads, []float64{ 4.5 })
  let echoed = converter.EchoAll[Payload](payloads)

  let deep = DeepPayloadConverter()
  let wrapped = Box[Payload]()
  let transformed = deep.Transform(wrapped)
  let current = deep.Current

  return payload.Value == 2.5
    && echoed[0].Value == 4.5
    && transformed == wrapped ? 0 : 1
}`, []string{libraryPath})
            Assert.Empty(result.Diagnostics)
            Assert.Equal(0, result.ExitCode)
            Assert.Equal(0, Assert.IsType[int32](result.Value))
        } finally {
            Directory.Delete(outputDirectory, recursive: true)
        }
    }

    @Fact
    func NestedConsumerTypeArgument_Mismatch_RemainsGS0185() {
        let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue3335", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(outputDirectory)
        try {
            let libraryPath = EmitLibrary(outputDirectory)
            let result = EmittedOracle.Evaluate(`package FindingCrossAssemblyGenericOverrideApp

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

  public override func EchoAll[U](items []U) []U {
    return items
  }
}

public open class BadMethodConverter : Converter[Payload] {
  public override func Read(item Payload, data []float64) {
  }

  public override func Write(data []float64) Payload {
    return Payload{}
  }

  public override func ReadAll(items []Payload, data []float64) {
  }

  public override func WriteAll(data []float64) []Payload {
    return []Payload{}
  }

  public override func EchoAll[U](items []U) []Payload {
    return []Payload{}
  }
}

public open class BadDeepConverter : DeepMid[Payload] {
  public override func Transform(item Box[float64]) Box[Payload] {
    return Box[Payload]()
  }

  public override prop Current Box[Payload] {
    get {
      return Box[Payload]()
    }
  }
}`, []string{libraryPath})
            Assert.Equal(3, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0185"))
        } finally {
            Directory.Delete(outputDirectory, recursive: true)
        }
    }

    shared {
        private const LibrarySource string = `package FindingCrossAssemblyGenericOverride

public open class Converter[T] {
  public open func Read(item T, data []float64);
  public open func Write(data []float64) T;
  public open func ReadAll(items []T, data []float64);
  public open func WriteAll(data []float64) []T;
  public open func EchoAll[U](items []U) []U;
}

public class Box[T] {
}

public open class DeepRoot[T] {
  public open func Transform(item T) T;
  public open prop Current T { get; }
}

public open class DeepBase[T] : DeepRoot[T] {
}

public open class DeepMid[T] : DeepBase[Box[T]] {
}`

        private func EmitLibrary(outputDirectory string) string {
            let libraryPath = Path.Combine(outputDirectory, "FindingCrossAssemblyGenericOverride.dll")
            let library = Compilation(SyntaxTree.Parse(SourceText.From(LibrarySource))){IsLibrary = true}
            using let output = File.Create(libraryPath)
            let emit = library.Emit(
                output,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "FindingCrossAssemblyGenericOverride"
            )
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            return libraryPath
        }
    }
}
