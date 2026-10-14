// xUnit coverage of the L2-Library public surface.

package Corpus.L2.Tests

import Corpus.L2
import System
import Xunit

class ShapesTests {
    @Fact
    func Circle_Area_And_Perimeter() {
        let circle = Circle(2.0)
        Assert.Equal(ShapeKind.Circle, circle.Kind)
        Assert.Equal(12.566370614359172, circle.Area(), 9)
        Assert.Equal(12.566370614359172, circle.Perimeter(), 9)
    }

    @Theory
    @InlineData(3.0, 4.0, 12.0)
    @InlineData(2.5, 2.0, 5.0)
    @InlineData(0.0, 9.0, 0.0)
    func Rectangle_Area_From_Dimensions(width float64, height float64, expectedArea float64) {
        let rectangle = Rectangle(Dimensions(width, height))
        Assert.Equal(ShapeKind.Rectangle, rectangle.Kind)
        Assert.Equal(expectedArea, rectangle.Area())
    }

    @Fact
    func Point_DistanceTo_Is_Euclidean() {
        let a = Point(0.0, 0.0)
        let b = Point(3.0, 4.0)
        Assert.Equal(5.0, a.DistanceTo(b))
    }

    @Fact
    func RecordStruct_Has_Structural_Equality() {
        Assert.Equal(Point(1.0, 2.0), Point(1.0, 2.0))
        Assert.NotEqual(Point(1.0, 2.0), Point(2.0, 1.0))
    }

    @Fact
    func Record_Has_Structural_Equality_And_With() {
        let red = NamedColor("red", 0xFF0000)
        let alsoRed = red with{}
        Assert.Equal(red, alsoRed)
        let green = red with{Name = "green", Rgb = 0x00FF00}
        Assert.NotEqual(red, green)
        Assert.Equal("green", green.Name)
    }

    @Fact
    func Dimensions_Init_Properties() {
        let dims = Dimensions{Width: 6.0, Height: 7.0}
        Assert.Equal(42.0, dims.Width * dims.Height)
    }

    @Fact
    func Geometry_TotalArea_Overloads() {
        let c = Circle(1.0)
        let r = Rectangle(Dimensions(2.0, 3.0))
        let t = Circle(0.0)
        let two = Geometry.TotalArea(c, r)
        let three = Geometry.TotalArea(c, r, t)
        Assert.Equal(two, three)
        Assert.Equal(6.0 + Math.PI, three, 9)
    }

    @Theory
    @InlineData(1.2345, 1.23)
    @InlineData(1.2355, 1.24)
    @InlineData(2.5, 2.5)
    func Geometry_Round_Default_Digits(value float64, expected float64) {
        Assert.Equal(expected, Geometry.Round(value))
    }

    @Theory
    @InlineData(1.234, int32(123))
    @InlineData(9.99, int32(999))
    func Geometry_ToCents_Rounds_Half_Up(dollars float64, expectedCents int32) {
        Assert.Equal(expectedCents, Geometry.ToCents(dollars))
    }
}
