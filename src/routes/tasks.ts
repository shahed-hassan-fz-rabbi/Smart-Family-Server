import { Router } from 'express';
import { Types } from 'mongoose';
import { Task } from '../models/task';
import { FamilyMembership } from '../models/family';
import { requireAuth, roleAtLeast } from '../middleware/auth';
import { requireFamilyMembership, HttpError } from '../middleware/familyAccess';
import { validate } from '../middleware/validate';
import { createTaskSchema, updateTaskSchema, listTasksQuery } from '../validators/content';
import { createNotification } from '../services/notification';

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

tasksRouter.get('/', validate(listTasksQuery, 'query'), async (req, res, next) => {
  try {
    const { familyId } = await requireFamilyMembership(req, req.query.familyId as string);
    const q = req.query as unknown as {
      status?: 'pending' | 'in_progress' | 'completed';
      assigneeId?: string;
      priority?: 'low' | 'medium' | 'high';
      overdue?: 'true' | 'false';
      limit: number;
      skip: number;
    };
    const filter: Record<string, unknown> = { familyId };
    if (q.status) filter.status = q.status;
    if (q.assigneeId) filter.assigneeId = q.assigneeId;
    if (q.priority) filter.priority = q.priority;
    if (q.overdue === 'true') filter.dueDate = { $lt: new Date() }, filter.status = { $ne: 'completed' };

    const [tasks, totalCount] = await Promise.all([
      Task.find(filter)
        .sort({ dueDate: 1, createdAt: -1 })
        .skip(q.skip)
        .limit(q.limit)
        .populate('assigneeId', 'name')
        .populate('createdById', 'name')
        .lean(),
      Task.countDocuments(filter),
    ]);
    res.json({
      tasks: tasks.map((t) => ({
        id: String(t._id),
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate,
        completedAt: t.completedAt,
        createdBy: t.createdBy,
        assignee: t.assigneeId
          ? { id: String((t.assigneeId as unknown as { _id: Types.ObjectId })._id), name: (t.assigneeId as unknown as { name: string }).name }
          : null,
        created: t.createdById
          ? String((t.createdById as unknown as { _id: Types.ObjectId })._id)
          : null,
      })),
      total: totalCount,
    });
  } catch (err) {
    next(err);
  }
});

tasksRouter.post('/', validate(createTaskSchema), async (req, res, next) => {
  try {
    const { familyId } = await requireFamilyMembership(req, req.body.familyId);
    if (req.body.assigneeId) {
      await assertFamilyMember(familyId, req.body.assigneeId);
    }
    const task = await Task.create({
      familyId,
      title: req.body.title,
      description: req.body.description,
      priority: req.body.priority,
      dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined,
      assigneeId: req.body.assigneeId ?? req.user!.id,
      createdById: req.user!.id,
    });
    if (task.assigneeId && !task.assigneeId.equals(req.user!.id)) {
      await createNotification({
        userId: task.assigneeId as Types.ObjectId,
        familyId,
        type: 'task_assigned',
        title: `New task assigned: ${task.title}`,
        message: `${req.user!.name} assigned you a task`,
        linkPath: '/tasks',
        refType: 'task',
        refId: task._id as Types.ObjectId,
        dedupeKey: `task-assign-${task._id}`,
      });
    }
    res.status(201).json({ task: { id: String(task._id), title: task.title } });
  } catch (err) {
    next(err);
  }
});

tasksRouter.patch('/:taskId', validate(updateTaskSchema), async (req, res, next) => {
  try {
    const body = req.body as { familyId?: string };
    if (!body.familyId) throw new HttpError(400, 'familyId is required for task updates');
    const { familyId } = await requireFamilyMembership(req, body.familyId);
    const task = await Task.findOne({ _id: req.params.taskId, familyId });
    if (!task) throw new HttpError(404, 'Task not found');

    const previouslyUnassigned = !task.assigneeId;
    const statusChangedToCompleted = req.body.status === 'completed' && task.status !== 'completed';
    if (req.body.title) task.title = req.body.title;
    if (req.body.description !== undefined) task.description = req.body.description;
    if (req.body.priority) task.priority = req.body.priority;
    if (req.body.dueDate) task.dueDate = new Date(req.body.dueDate);
    if (req.body.assigneeId) {
      await assertFamilyMember(familyId, req.body.assigneeId);
      task.assigneeId = new Types.ObjectId(req.body.assigneeId);
    }
    if (req.body.status) {
      task.status = req.body.status;
      task.completedAt = req.body.status === 'completed' ? new Date() : null as unknown as Date;
    }
    await task.save();

    if (previouslyUnassigned && task.assigneeId) {
      await assertFamilyMember(familyId, String(task.assigneeId));
    }
    if (statusChangedToCompleted && task.createdById !== task.assigneeId && task.createdById) {
      await createNotification({
        userId: task.createdById as Types.ObjectId,
        familyId,
        type: 'task_completed',
        title: `Task completed: ${task.title}`,
        linkPath: '/tasks',
        refType: 'task',
        refId: task._id as Types.ObjectId,
        dedupeKey: `task-done-${task._id}-${Date.now()}`,
      });
    }
    res.json({ task: { id: String(task._id), status: task.status } });
  } catch (err) {
    next(err);
  }
});

tasksRouter.delete('/:taskId', async (req, res, next) => {
  try {
    const bodyFamilyId = (req.query.familyId ?? req.body?.familyId) as string | undefined;
    if (!bodyFamilyId) throw new HttpError(400, 'familyId query parameter is required');
    const { familyId, role } = await requireFamilyMembership(req, bodyFamilyId);
    const task = await Task.findOne({ _id: req.params.taskId, familyId });
    if (!task) throw new HttpError(404, 'Task not found');
    const isCreator = String(task.createdById) === String(req.user!.id);
    const isAssignee = String(task.assigneeId) === String(req.user!.id);
    if (!isCreator && !isAssignee && !roleAtLeast(role, 'admin')) {
      throw new HttpError(403, 'Only the creator, assignee, or a family admin can delete this task');
    }
    await task.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

async function assertFamilyMember(familyId: Types.ObjectId, userId: string): Promise<void> {
  const membership = await FamilyMembership.findOne({ familyId, userId });
  if (!membership) throw new HttpError(400, 'The assignee is not a member of this family');
}
