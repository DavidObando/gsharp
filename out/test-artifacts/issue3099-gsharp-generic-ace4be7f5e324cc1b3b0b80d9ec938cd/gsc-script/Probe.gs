package Issue3099.Casegsharpgeneric
import System
import System.Collections.Generic

struct Payload[T] {
    let Value T
    var Imported List[T]
    var Slice []T
    var Nullable T?
    var Array [3]T
    shared {
        var Stat int32
    }
    const Kilo int32 = 1000
}

struct ReflectionControl {
    let Eleven int32
    var TwentyTwo string
}

class Box[T] : EventArgs {
}

class Pair[TFirst, TSecond] : EventArgs {
}

func FieldShape(t Type) string {
    var shape = t.GetFields().Length.ToString()
    for field in t.GetFields() {
        shape = shape + "|" + field.Name + ":" + field.FieldType.FullName + ":" + field.IsInitOnly.ToString() + ":" + field.IsStatic.ToString() + ":" + field.IsLiteral.ToString()
        if field.IsLiteral {
            shape = shape + ":" + field.GetRawConstantValue().ToString()
        }
    }
    return shape
}

var single = Box[Payload[int32]]()
Console.WriteLine(11)
Console.WriteLine(single.GetType().FullName)
Console.WriteLine(single.GetType().GenericTypeArguments[0].IsValueType)
Console.WriteLine(single.GetType().GenericTypeArguments[0].IsEnum)
Console.WriteLine(single.GetType().GenericTypeArguments[0].IsLayoutSequential)
Console.WriteLine(FieldShape(single.GetType().GenericTypeArguments[0]))
var multiple = Pair[Payload[int32], int32]()
Console.WriteLine(22)
Console.WriteLine(multiple.GetType().FullName)
Console.WriteLine(Object.ReferenceEquals(
    single.GetType().GenericTypeArguments[0],
    multiple.GetType().GenericTypeArguments[0]))
Console.WriteLine(FieldShape(multiple.GetType().GenericTypeArguments[0]))
Console.WriteLine(33)
var nested = Box[Box[Payload[int32]]]()
Console.WriteLine(nested.GetType().FullName)
Console.WriteLine(FieldShape(nested.GetType().GenericTypeArguments[0].GenericTypeArguments[0]))
var control = Box[ReflectionControl]()
Console.WriteLine(44)
Console.WriteLine(FieldShape(control.GetType().GenericTypeArguments[0]))