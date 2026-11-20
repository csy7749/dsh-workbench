"""Original fixed worker: declarative primitives only; no external inputs or scripts."""
import hashlib
import json
import math
import re
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def require(value, code):
    if not value:
        raise ValueError(code)


def main():
    root = Path(__file__).resolve().parent
    require(sys.argv[sys.argv.index("--") + 1:] == ["job.json"], "job_argument_invalid")
    raw = (root / "job.json").read_bytes()
    require(len(raw) <= 16384, "job_too_large")
    job = json.loads(raw)
    require(set(job) == {"schemaVersion", "workerVersion", "jobId", "projectId", "productId", "slug", "recipe"}, "job_fields_invalid")
    require(job["schemaVersion"] == 1 and job["workerVersion"] == 1 and re.fullmatch(r"[a-f0-9-]{36}", job["jobId"]), "job_invalid")
    recipe = job["recipe"]
    require(isinstance(recipe, dict) and set(recipe) == {"primitive", "color", "size"}, "recipe_invalid")
    require(recipe["primitive"] in ("crate", "pickup"), "primitive_invalid")
    size = recipe["size"]
    require(type(size) in (int, float) and math.isfinite(size) and 0.1 <= size <= 4, "size_invalid")
    require(isinstance(recipe["color"], str) and re.fullmatch(r"#[A-F0-9]{6}", recipe["color"]), "color_invalid")
    output = root / "output"
    require(output.is_dir() and not output.is_symlink() and not any(output.iterdir()), "output_invalid")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    color = tuple(int(recipe["color"][i:i + 2], 16) / 255 for i in (1, 3, 5))

    def material(name, rgb):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        mat.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (*rgb, 1)
        mat.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = 0.65
        mat.diffuse_color = (*rgb, 1)
        return mat

    primary = material("MAT_Primary", color)
    accent = material("MAT_Accent", tuple(c * 0.45 for c in color))
    meshes = []

    def cube(name, dimensions, location, mat):
        bpy.ops.mesh.primitive_cube_add(size=1, location=location)
        obj = bpy.context.object
        obj.name = name
        obj.dimensions = dimensions
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        obj.data.materials.append(mat)
        meshes.append(obj)

    if recipe["primitive"] == "crate":
        cube("SM_Crate", (size, size, size), (0, 0, size / 2), primary)
        for index, height in enumerate((size * 0.15, size * 0.85)):
            cube("SM_BandHorizontal_%d" % index, (size * 1.02, size * 1.02, size * 0.1), (0, 0, height), accent)
        for index, x in enumerate((-size * 0.4, size * 0.4)):
            cube("SM_BandVertical_%d" % index, (size * 0.1, size * 1.02, size * 1.02), (x, 0, size / 2), accent)
    else:
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=size * 0.5, location=(0, 0, size / 2))
        obj = bpy.context.object
        obj.name = "SM_Pickup"
        obj.data.materials.append(primary)
        meshes.append(obj)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    triangle_count = 0
    vertices = []
    for obj in meshes:
        obj.data.calc_loop_triangles()
        triangle_count += len(obj.data.loop_triangles)
        vertices.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
    dimensions = [max(v[a] for v in vertices) - min(v[a] for v in vertices) for a in range(3)]
    require(triangle_count <= 10000 and all(0 < n < 8 for n in dimensions), "geometry_budget_invalid")
    require(bpy.ops.export_scene.gltf(filepath=str(output / "asset.glb"), export_format="GLB", use_selection=True, export_yup=True, export_apply=True, export_animations=False, export_cameras=False, export_lights=False) == {"FINISHED"}, "glb_export_failed")
    bpy.ops.object.camera_add(location=(size * 2.8, -size * 3.5, size * 2.6))
    camera = bpy.context.object
    camera.name = "CAM_Preview"
    camera.rotation_euler = (Vector((0, 0, size / 2)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = size * 1.85
    scene.camera = camera
    bpy.ops.object.light_add(type="AREA", location=(size * 2, -size * 3, size * 4))
    light = bpy.context.object
    light.name = "LGT_Key"
    light.data.energy = 400 * size * size
    light.data.shape = "DISK"
    light.data.size = size * 4
    light.rotation_euler = (Vector((0, 0, size / 2)) - light.location).to_track_quat("-Z", "Y").to_euler()
    # CPU Cycles works in background without depending on a graphics context.
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 8
    scene.render.resolution_x = 128
    scene.render.resolution_y = 128
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.filepath = str(output / "preview.png")
    require(bpy.ops.render.render(write_still=True) == {"FINISHED"}, "render_failed")
    require(bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"), compress=False) == {"FINISHED"}, "blend_save_failed")
    files = {}
    for name in ("asset.glb", "preview.png", "scene.blend"):
        path = output / name
        require(path.is_file() and not path.is_symlink(), "output_missing")
        data = path.read_bytes()
        require(0 < len(data) <= (262144 if name.endswith(".png") else 16777216), "output_size_invalid")
        files[name] = {"bytes": len(data), "hash": hashlib.sha256(data).hexdigest()}
    report = {"schemaVersion": 1, "workerVersion": 1, "status": "completed", "jobId": job["jobId"], "projectId": job["projectId"], "productId": job["productId"], "slug": job["slug"], "jobHash": hashlib.sha256(raw).hexdigest(), "recipe": recipe, "blenderVersion": bpy.app.version_string, "renderEngine": scene.render.engine, "triangleCount": triangle_count, "dimensionsMetres": dimensions, "files": files}
    (output / "report.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
