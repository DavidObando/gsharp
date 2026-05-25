package TwoLambdaTest
import System
import System.Threading.Tasks

var a = 10
var b = 20

var f1 = async func() int {
    await Task.Yield()
    return a + 1
}

var f2 = async func() int {
    await Task.Yield()
    return b + 2
}

var t1 = f1()
var t2 = f2()
t1.Wait()
t2.Wait()
Console.WriteLine(t1.Result)
Console.WriteLine(t2.Result)
