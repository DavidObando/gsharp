import Gsharp.Extensions.Optional
import Gsharp.Values
import System

sealed interface IAdd {
    shared{func Add(a int32, b int32) int32;}
}

class Plus : IAdd {
    shared {
        func Add(a int32, b int32) int32 {
            return a + b
        }
    }
}

func Apply[T IAdd](w T, a int32, b int32) int32 {
    return T.Add(a, b)
}

Console.WriteLine(Apply[Plus](Plus{}, 3, 4))
let text string? = "Ada"
let count int32? = 7
Console.WriteLine(text.Map((s string) -> s.ToUpper()) ?? "")
Console.WriteLine(count.Map((n int32) -> n * 2) ?? -1)
var values = slice[int32].Create(0, 2)
values = values.Append(4)
let reader readonly slice[int32] = values
Console.WriteLine(reader[0])
Console.WriteLine(values.ToArray().Length)
Console.WriteLine(b"\xFF\0".Length)
Console.WriteLine(ByteString.EncodeUtf8("hi", Utf16Encoding.Strict).DecodeUtf8(Utf8Decoding.Strict))
var missing string
Console.WriteLine(object.ReferenceEquals(missing, nil))
var array[]int32
Console.WriteLine(array.Length)
