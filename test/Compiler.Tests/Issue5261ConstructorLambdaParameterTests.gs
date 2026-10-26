// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import System
import System.Text
import Xunit

class Issue5261ConstructorLambdaParameterTests {
    @Fact
    func ImportedConstructorCallbackKeepsArrayParameterAndCapturedReadState() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.Compile(`package Fixture
import System
public class SoundStreamSource {
 public let Read Func[[]float32, int32, int32]
 public init(sampleRate int32, channels int32, read Func[[]float32, int32, int32]) { Read = read }
}`, "Fixture", false)
        IlVerifier.Verify(library)
        let create = `import System
import Fixture
func Create() SoundStreamSource {
 var reads = 0
 return SoundStreamSource(8000, 2, (buffer []float32, frames int32) -> {
  if (reads += 1) > 3 { return 0 }
  let count = Math.Min(80, frames)
  for var i = 0; i < count * 2; i++ { buffer[i] = if i % 2 == 0 { -2 } else { 2 } }
  return count
 })
}`
        let harness = `
func Dump(samples []float32) {
 let bytes = [samples.Length * 4]byte
 Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length)
 Console.WriteLine(Convert.ToHexString(bytes))
}
func Main() {
 let source = Create()
 let other = Create()
 let samples = []float32{9, 9, 9, 9, 9, 9, 9, 9}
 Console.WriteLine(source.Read(samples, 3))
 Dump(samples)
 let next = []float32{5, 5, 5, 5}
 Console.WriteLine(source.Read(next, 1))
 Dump(next)
 Console.WriteLine(source.Read(samples, 2))
 Console.WriteLine(source.Read(next, 2))
 Dump(next)
 Console.WriteLine(other.Read(next, 2))
 Dump(next)
 let fault = Create()
 try { fault.Read([]float32{}, 1) }
 catch (error IndexOutOfRangeException) { Console.WriteLine("bounds") }
 Console.WriteLine(fault.Read(next, 0))
 Console.WriteLine(fault.Read(next, 0))
 Console.WriteLine(fault.Read(next, 2))
 Dump(next)
}`
        let expected = Encoding.UTF8.GetBytes(`3
000000C000000040000000C000000040000000C0000000400000104100001041
1
000000C0000000400000A0400000A040
2
0
000000C0000000400000A0400000A040
2
000000C000000040000000C000000040
bounds
0
0
0
000000C000000040000000C000000040
`)
        for mode in[]string{"inline", "local", "method"} {
            var consumer = create
            if mode == "local" {
                consumer = create.Replace(
                    "return SoundStreamSource(8000, 2, ",
                    "let read Func[[]float32, int32, int32] = ",
                    StringComparison.Ordinal
                )
                    .Replace(" })", " }\n return SoundStreamSource(8000, 2, read)", StringComparison.Ordinal)
            } else if mode == "method" {
                consumer = create.Replace("SoundStreamSource(8000, 2, ", "Make(", StringComparison.Ordinal) +
                    "\nfunc Make(read Func[[]float32, int32, int32]) SoundStreamSource -> SoundStreamSource(8000, 2, read)"
            }
            let dll = fixture.Compile(consumer + harness, mode, true, "/reference:" + library)
            IlVerifier.Verify(dll, []string{library})
            Assert.Equal(expected, Encoding.UTF8.GetBytes(fixture.Run(dll)))
        }
    }

    @Fact
    func ReturnWideningAdapterRewritesArrayTargetsAndEvaluatesOperandsOnceInOrder() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package AdaptedArray
import System
var trace = ""
func Index() int32 {
 trace += "I"
 return 1
}
func Value() int32 {
 trace += "V"
 return 7
}
func Accept(callback Func[[]int32, int64]) Func[[]int32, int64] -> callback
func Main() {
 var calls = 0
 let callback = Accept(func(samples []int32) int32 {
  calls++
  samples[Index()] = Value() + calls
  return calls
 })
 let samples = []int32{3, 4, 5}
 Console.WriteLine(callback(samples))
 Console.WriteLine(callback(samples))
 let bytes = [12]byte
 Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length)
 Console.WriteLine(Convert.ToHexString(bytes))
 Console.WriteLine(trace)
}
Main()`, "AdaptedArray", true)
        IlVerifier.Verify(dll)
        Assert.Equal(
            Encoding.UTF8.GetBytes("1\n2\n030000000900000005000000\nIVIV\n"),
            Encoding.UTF8.GetBytes(fixture.Run(dll))
        )
    }
}
