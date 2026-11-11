package GSharp.Compiler.Tests

import GSharp.Tests
import System.Text
import Xunit

class Issue5956ImportedNullableTupleContractTests {
    @Fact
    func ImportedTupleArrayNullability_CompileAndRun() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.Compile(`package Library5956
import System.Collections.Generic
shared class Api {
    func Prepare() IReadOnlyList[(Path string, Original[]?uint8)] ->
        List[(Path string, Original[]?uint8)]{("props", nil)}
    func Nested() IReadOnlyList[(Values[]string?, Required[]uint8)] ->
        List[(Values[]string?, Required[]uint8)]{([]string?{nil, "keep"}, []uint8{7})}
}`, "Library5956", executable: false)
        let consumer = fixture.Compile(`import Library5956
import System
import System.Collections.Generic
let prepared IReadOnlyList[(Path string, Original[]?uint8)] = Api.Prepare()
Console.WriteLine(prepared[0].Path + ":" + (prepared[0].Original == nil).ToString())
let nested IReadOnlyList[(Values[]string?, Required[]uint8)] = Api.Nested()
Console.WriteLine((nested[0].Values[0] == nil).ToString() + ":" + nested[0].Required.Length.ToString())
let rows IEnumerable[(Path string, Original[]?uint8)] = Api.Prepare()
for row in rows { Console.WriteLine(row.Original == nil) }
`, "Consumer5956", executable: true, "/r:" + library)
        IlVerifier.Verify(consumer, []string{library})
        Assert.Equal(Encoding.UTF8.GetBytes("props:True\nTrue:1\nTrue\n"), fixture.RunBytes(consumer))
        let (code, output) = fixture.TryCompile(`import Library5956
let original[]uint8 = Api.Prepare()[0].Original
`, "NarrowConsumer5956", executable: true, "/r:" + library)
        Assert.NotEqual(0, code)
        Assert.Contains("NarrowConsumer5956.gs(2,23,2,48): error GS0156", output)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedOptionalTupleToString_PreservesNullableRuntimeBehavior(present bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.Compile(`package OptionalLibrary5956
shared class Api {
    func Read(present bool)(NupkgPath string, Version string?)? {
        if present { return ("sdk", nil) }
        return nil
    }
}`, "OptionalLibrary5956", executable: false)
        let argument = if present {
            "true"
        } else {
            "false"
        }
        let consumer = fixture.Compile(`import OptionalLibrary5956
import System
let sdk = Api.Read(` + argument + `)
Console.WriteLine("SDK package: " + sdk.ToString())
Console.WriteLine(sdk.HasValue)
Console.WriteLine(sdk.Equals(nil))
`, "OptionalConsumer5956", executable: true, "/r:" + library)
        IlVerifier.Verify(consumer, []string{library})
        let expected = if present {
            "SDK package: (sdk, )\nTrue\nFalse\n"
        } else {
            "SDK package: \nFalse\nTrue\n"
        }
        Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(consumer))
    }
}
